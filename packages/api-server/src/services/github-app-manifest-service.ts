// Implements the GitHub App manifest flow
// (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
//
// The flow:
//   1. UI hits GET /manifest, gets a JSON spec and a one-time state token.
//   2. UI redirects user to github.com/.../settings/apps/new with the
//      state and a `manifest_url=...` query that points back at this
//      server's /manifest endpoint.
//   3. GitHub renders a pre-filled "Create App" form. User clicks Create.
//   4. GitHub redirects the user to our redirect_url with `code` + `state`.
//   5. We validate `state`, POST the code to api.github.com to exchange
//      it for the App's credentials (App ID + PEM + webhook secret + ...).
//   6. We write the PEM to disk and persist the App ID + key path via
//      GitHubAppService. Redirect the user back to /connectors so the
//      wizard can resume.
//
// State tokens live in memory with a short TTL — surviving a process
// restart isn't worth the persistence cost, the user just re-clicks.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { GitHubAppService } from './github-app-service.js';

// Match GitHub's manifest schema, narrowed to the fields we substitute or
// surface. The static template carries more keys than this (description,
// permissions, events) — we pass those through untouched.
interface RawManifest {
  name?: string;
  url?: string;
  description?: string;
  public?: boolean;
  default_permissions?: Record<string, string>;
  default_events?: string[];
  hook_attributes?: { url: string; active?: boolean };
  redirect_url?: string;
  [key: string]: unknown;
}

export interface ManifestServiceOptions {
  // Absolute path to the static manifest template (config/github-app-manifest.json).
  templatePath: string;
  appService: GitHubAppService;
  // Where to write PEMs received from the conversion exchange. Defaults
  // to `~/.shipit/keys` and is overridable via env so containers can
  // point at a mounted secrets volume.
  keyDir?: string;
  // Override the conversion endpoint for tests (mocks). Production
  // hardcodes api.github.com.
  conversionEndpoint?: (code: string) => string;
  // Fetch implementation (testable seam — default to global fetch).
  fetchImpl?: typeof fetch;
}

export interface ConversionResult {
  // What the wizard's success page surfaces to the user. We deliberately
  // don't include the PEM contents here — they're already persisted.
  appId: string;
  appName: string;
  installUrl: string;
  // Path where we wrote the PEM. Echoed back so the user can verify.
  privateKeyPath: string;
  // Webhook secret returned by GitHub. We write it to a sidecar file
  // (chmod 600) but DO NOT write it to YAML — the user has to wire it
  // into the GITHUB_WEBHOOK_SECRET env var themselves. The path is
  // surfaced so they can `export GITHUB_WEBHOOK_SECRET=$(cat ...)`.
  webhookSecretPath: string;
}

// In-memory state token store. Map<token, { createdAt }>. 15-minute TTL.
const STATE_TTL_MS = 15 * 60 * 1000;

export class GitHubAppManifestService {
  private templatePath: string;
  private appService: GitHubAppService;
  private keyDir: string;
  private conversionEndpoint: (code: string) => string;
  private fetchImpl: typeof fetch;
  private states = new Map<string, { createdAt: number }>();

  constructor(opts: ManifestServiceOptions) {
    this.templatePath = opts.templatePath;
    this.appService = opts.appService;
    // Resolve the key dir. The default works for local dev; container
    // deployments override via SHIPIT_GITHUB_APP_KEY_DIR. `~` is
    // expanded at construction since fs.* doesn't do shell expansion.
    const raw = opts.keyDir ?? join(homedir(), '.shipit', 'keys');
    this.keyDir = isAbsolute(raw) ? raw : resolve(raw);
    this.conversionEndpoint =
      opts.conversionEndpoint ??
      ((code) => `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // Return the manifest JSON the UI will hand to GitHub via `manifest_url`.
  // Webhook URL + redirect URL are filled from runtime config so each
  // ShipIt instance points at its own ingress.
  buildManifest(args: { webhookUrl: string; redirectUrl: string }): RawManifest {
    const template = JSON.parse(readFileSync(this.templatePath, 'utf-8')) as RawManifest;
    // The `$comment` field is informational only — strip it before
    // GitHub sees the manifest; GitHub treats unknown fields as no-ops
    // but the comment confuses anyone reading the live manifest URL.
    const out: RawManifest = { ...template };
    delete (out as Record<string, unknown>).$comment;
    out.hook_attributes = { url: args.webhookUrl, active: true };
    out.redirect_url = args.redirectUrl;
    return out;
  }

  // Issue a fresh state token. The UI sends this to GitHub's "Create
  // App" page; GitHub echoes it back on the callback so we can verify
  // the round-trip wasn't tampered with. One-time-use — consumed on
  // callback validation.
  issueState(): string {
    this.gc();
    const token = randomBytes(24).toString('hex');
    this.states.set(token, { createdAt: Date.now() });
    return token;
  }

  // Returns true if the state was issued by us and hasn't expired.
  // Consumes the state — re-validating the same token returns false.
  consumeState(token: string | undefined): boolean {
    if (!token) return false;
    this.gc();
    const entry = this.states.get(token);
    if (!entry) return false;
    this.states.delete(token);
    return true;
  }

  // Exchange the one-time `code` GitHub sent on the callback for the
  // App's credentials, write the PEM to disk, persist via GitHubAppService.
  // The conversion code is single-use and expires within ~60 seconds —
  // network blips here just mean the user re-runs the flow.
  async exchangeAndPersist(code: string): Promise<ConversionResult> {
    const url = this.conversionEndpoint(code);
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ShipIt-AI',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `GitHub manifest conversion failed: HTTP ${res.status} ${res.statusText}${
          body ? ` — ${body.slice(0, 500)}` : ''
        }`,
      );
    }
    const payload = (await res.json()) as {
      id?: number | string;
      name?: string;
      html_url?: string;
      pem?: string;
      webhook_secret?: string | null;
      client_id?: string;
      client_secret?: string;
    };
    if (!payload.id || !payload.pem) {
      throw new Error(
        'GitHub manifest conversion returned an incomplete payload (missing id or pem)',
      );
    }
    const appId = String(payload.id);
    const pem = payload.pem;
    const webhookSecret = payload.webhook_secret ?? '';

    // mkdir -p the key dir if needed. We chmod 700 on the dir and 600 on
    // the file — strict permissions matter because the PEM is the
    // single most sensitive piece of material in the system.
    mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    const keyPath = join(this.keyDir, `github-app-${appId}.pem`);
    writeFileSync(keyPath, pem, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(keyPath, 0o600);

    // Webhook secret goes to a sidecar file. We don't put it in YAML
    // (secretlint blocks it) and we don't auto-set the env var (would
    // require process-replacement). Users `export ... = $(cat ...)`.
    const secretPath = join(this.keyDir, `github-app-${appId}.webhook-secret`);
    writeFileSync(secretPath, webhookSecret + '\n', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(secretPath, 0o600);

    // Persist via the existing service so the in-memory config + the
    // YAML stay in sync (and the scheduler picks up the new credentials
    // on its next poll). No ETag — manifest flow is a destructive
    // overwrite by design.
    await this.appService.update({ id: appId, privateKeyPath: keyPath }, undefined);

    return {
      appId,
      appName: payload.name ?? `App ${appId}`,
      installUrl: payload.html_url ?? `https://github.com/apps/${payload.name ?? ''}`,
      privateKeyPath: keyPath,
      webhookSecretPath: secretPath,
    };
  }

  // Drop expired state tokens. Called opportunistically — bounded by
  // the rate at which states are issued/consumed; no separate timer.
  private gc(): void {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [token, entry] of this.states) {
      if (entry.createdAt < cutoff) this.states.delete(token);
    }
  }
}

// Re-exported for tests that need to bypass the JS-host's `fs` boundary
// (e.g. by passing a tmpdir keyDir + a mock fetch).
export { dirname };
