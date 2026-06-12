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
import { fileURLToPath } from 'node:url';
import type { GitHubAppService } from './github-app-service.js';

// Default manifest template location. The template ships INSIDE this
// package (packages/api-server/config/) and is resolved relative to this
// module — NOT relative to the shipit.config.yaml directory. Deployed
// images are `pnpm deploy --prod` output without the repo root, and the
// on-cluster config volume only seeds shipit.config.yaml + the schema,
// so a configDir-relative lookup ENOENTs in production (see
// docs/agent/investigations/setup-wizard-manifest-launch-enoent.md).
// Works from both src/services/ (tsx dev) and dist/services/ (built):
// each sits two levels below the package root.
//
// SHIPIT_GITHUB_APP_MANIFEST_TEMPLATE overrides for operators who want
// to customize the App's permissions/events without rebuilding.
export function resolveManifestTemplatePath(): string {
  const override = process.env.SHIPIT_GITHUB_APP_MANIFEST_TEMPLATE;
  if (override) return resolve(override);
  return fileURLToPath(new URL('../../config/github-app-manifest.json', import.meta.url));
}

import { GsmSecretStore } from '../secrets/gsm-store.js';
import type { LogicalSecret, SecretStore } from '../secrets/types.js';

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
  callback_urls?: string[];
  [key: string]: unknown;
}

export interface ManifestServiceOptions {
  // Absolute path to the static manifest template — callers should pass
  // resolveManifestTemplatePath() outside of tests.
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
  // Optional secret store. When it's the GSM store, the exchange also
  // persists the minted credentials durably (Workload Identity write
  // path). File mode deliberately skips this so local behavior is
  // byte-for-byte unchanged.
  secretStore?: SecretStore;
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
  // True when the credentials were durably persisted to GSM (gsm store
  // active). The callback page uses this to drop the "export
  // GITHUB_WEBHOOK_SECRET=$(cat …)" manual step.
  persistedToGsm: boolean;
}

// In-memory state token store. Map<token, { createdAt, target, nonce? }>.
// 15-minute TTL applies to both stores. `target` chooses where the
// callback writes the credentials:
//   - 'global':   GitHubAppService.update() → connectors.github.app.* (today's behavior)
//   - 'instance': stash in pendingInstanceMap so the wizard can claim
//                 them and attach to a connector instance's `app` override
const STATE_TTL_MS = 15 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;

export type ManifestTarget = 'global' | 'instance';

export interface PendingInstanceApp {
  appId: string;
  appName: string;
  privateKeyPath: string;
  webhookSecretPath: string;
  installUrl: string;
}

export class GitHubAppManifestService {
  private templatePath: string;
  private appService: GitHubAppService;
  private keyDir: string;
  private conversionEndpoint: (code: string) => string;
  private fetchImpl: typeof fetch;
  private secretStore?: SecretStore;
  private states = new Map<string, { createdAt: number; target: ManifestTarget; nonce?: string }>();
  // Keyed by the client-supplied `nonce` (uuid). The wizard generates
  // the nonce, hands it to the launch URL, the manifest service round-
  // trips it through the state token, and the callback stashes the
  // exchange result here when target='instance'. The wizard polls
  // GET /manifest/pending-instance/:nonce to claim the credentials.
  // Single-use: claimed → deleted.
  private pendingInstance = new Map<string, { createdAt: number; result: PendingInstanceApp }>();

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
    this.secretStore = opts.secretStore;
  }

  // Return the manifest JSON the launch endpoint POSTs to GitHub. Webhook
  // URL + redirect URL are filled from runtime config so each ShipIt
  // instance points at its own ingress.
  //
  // When the webhook URL isn't publicly reachable (localhost, 127.0.0.1,
  // ::1, private RFC-1918 ranges), `hook_attributes` is omitted. GitHub
  // rejects the entire manifest with "Hook url is not supported because
  // it isn't reachable over the public Internet" if we send a localhost
  // URL, so we'd rather create the App without a webhook and let the
  // operator configure it later via the App settings (or by setting
  // GITHUB_WEBHOOK_PUBLIC_URL to a smee channel and re-running).
  buildManifest(args: { webhookUrl: string; redirectUrl: string; callbackUrl: string }): {
    manifest: RawManifest;
    webhookOmitted: boolean;
    webhookOmissionReason?: string;
  } {
    const template = JSON.parse(readFileSync(this.templatePath, 'utf-8')) as RawManifest;
    // The `$comment` field is informational only — strip it before
    // GitHub sees the manifest; GitHub treats unknown fields as no-ops
    // but the comment confuses anyone reading the live manifest URL.
    const out: RawManifest = { ...template };
    delete (out as Record<string, unknown>).$comment;
    out.redirect_url = args.redirectUrl;
    // OAuth sign-in callback. Without this the created App has no
    // callback URL and the first login attempt dies on GitHub's "This
    // GitHub App must be configured with a callback URL" error page.
    out.callback_urls = [args.callbackUrl];

    const reason = checkWebhookUrlPublic(args.webhookUrl);
    if (reason) {
      // GitHub treats `default_events` and `hook_attributes` as a
      // coupled pair: subscribing to any event without a valid webhook
      // URL fails with "Hook url cannot be blank". Strip both together
      // so the App is created with permissions only — the operator
      // can add events + webhook URL via GitHub's App-settings UI
      // (or by setting GITHUB_WEBHOOK_PUBLIC_URL to a public ingress
      // and re-running the wizard).
      delete (out as Record<string, unknown>).hook_attributes;
      delete (out as Record<string, unknown>).default_events;
      return { manifest: out, webhookOmitted: true, webhookOmissionReason: reason };
    }
    out.hook_attributes = { url: args.webhookUrl, active: true };
    return { manifest: out, webhookOmitted: false };
  }

  // Issue a fresh state token. The UI sends this to GitHub's "Create
  // App" page; GitHub echoes it back on the callback so we can verify
  // the round-trip wasn't tampered with. One-time-use — consumed on
  // callback validation.
  //
  // `target` decides where the callback writes credentials — defaults
  // to 'global' for back-compat with the original shared-App flow. The
  // optional `nonce` (a wizard-generated UUID for target='instance') is
  // echoed back via consumeState so the callback can stash credentials
  // in the pending map under a key the wizard knows.
  issueState(opts: { target?: ManifestTarget; nonce?: string } = {}): string {
    this.gc();
    const token = randomBytes(24).toString('hex');
    this.states.set(token, {
      createdAt: Date.now(),
      target: opts.target ?? 'global',
      nonce: opts.nonce,
    });
    return token;
  }

  // Validates + consumes a state token. Returns `null` if unknown or
  // expired; otherwise returns the recorded target/nonce so the callback
  // can route the exchange result correctly.
  consumeState(token: string | undefined): { target: ManifestTarget; nonce?: string } | null {
    if (!token) return null;
    this.gc();
    const entry = this.states.get(token);
    if (!entry) return null;
    this.states.delete(token);
    return { target: entry.target, nonce: entry.nonce };
  }

  // Claim credentials stashed by a target='instance' exchange. The
  // wizard polls this with its nonce; returns the credentials exactly
  // once. After the wizard reads them they're gone — the wizard then
  // attaches them to the connector instance it creates.
  consumePendingInstance(nonce: string | undefined): PendingInstanceApp | null {
    if (!nonce) return null;
    this.gc();
    const entry = this.pendingInstance.get(nonce);
    if (!entry) return null;
    this.pendingInstance.delete(nonce);
    return entry.result;
  }

  // Exchange the one-time `code` GitHub sent on the callback for the
  // App's credentials, write the PEM to disk, and persist depending on
  // `target`:
  //   - 'global'   → GitHubAppService.update() writes connectors.github.app.*
  //   - 'instance' → stash in pendingInstance map; the wizard polls
  //                  /pending-instance/:nonce to claim and attach to
  //                  the connector instance's `app` override.
  //
  // The conversion code is single-use and expires within ~60 seconds —
  // network blips here just mean the user re-runs the flow.
  async exchangeAndPersist(
    code: string,
    opts: { target?: ManifestTarget; nonce?: string } = {},
  ): Promise<ConversionResult> {
    const target: ManifestTarget = opts.target ?? 'global';
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
      slug?: string;
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

    const appName = payload.name ?? `App ${appId}`;
    // BASE URL — the callback HTML appends "/installations/new". Use
    // the slug-based public form so org-owned Apps don't get redirected
    // by GitHub to the App's settings-within-the-owner-org page
    // (which then redirects /installations/new to the existing
    // installation in that org, defeating the "install in a new org"
    // CTA). See the GET /installations route for the same fix.
    const installUrl = payload.slug
      ? `https://github.com/apps/${payload.slug}`
      : (payload.html_url ?? `https://github.com/apps/${payload.name ?? ''}`);

    // Per-org (target='instance') Apps must never touch the global GSM
    // containers — same invariant as the in-memory global App slot (see
    // docs/agent/decisions/github-app-manifest-flow.md, target-routing
    // extension). Writing an instance App's credentials to
    // shipit-github-app-* would silently replace the shared App's
    // credentials at next boot hydration.
    let persistedToGsm = false;
    if (target === 'global' && this.secretStore?.kind === 'gsm') {
      await this.persistToGsm(this.secretStore, {
        appId,
        pem,
        webhookSecret,
        oauthClientId: payload.client_id ?? '',
        oauthClientSecret: payload.client_secret ?? '',
        keyPath,
      });
      persistedToGsm = true;
    }

    if (target === 'global') {
      // Persist via the existing service so the in-memory config + the
      // YAML stay in sync (and the scheduler picks up the new credentials
      // on its next poll). No ETag — manifest flow is a destructive
      // overwrite by design.
      await this.appService.update({ id: appId, privateKeyPath: keyPath }, undefined);
    } else {
      // Per-org / per-instance target: never touch the global App slot.
      // Stash the credentials so the wizard's create flow can attach
      // them to the connector instance's `app` override field. Keyed by
      // the wizard-supplied nonce; without it the credentials would be
      // unclaimable (the App still exists on GitHub — the user can
      // recover by switching to the manual-paste flow with the appId
      // and keyPath from the success page).
      if (opts.nonce) {
        this.pendingInstance.set(opts.nonce, {
          createdAt: Date.now(),
          result: {
            appId,
            appName,
            privateKeyPath: keyPath,
            webhookSecretPath: secretPath,
            installUrl,
          },
        });
      }
    }

    return {
      appId,
      appName,
      installUrl,
      privateKeyPath: keyPath,
      webhookSecretPath: secretPath,
      persistedToGsm,
    };
  }

  // Persist the minted credentials to GSM. Empty values are skipped
  // (GitHub omits webhook_secret when the manifest had no hook config).
  // On failure we throw with the container name + recovery path: the App
  // already exists on GitHub and the PEM is on disk, so the operator can
  // re-run the wizard or upload the value manually.
  // Partial state on failure is acceptable: the thrown error tells the
  // operator to re-run the wizard, and a re-run overwrites every value
  // idempotently.
  private async persistToGsm(
    store: SecretStore,
    args: {
      appId: string;
      pem: string;
      webhookSecret: string;
      oauthClientId: string;
      oauthClientSecret: string;
      keyPath: string;
    },
  ): Promise<void> {
    const writes: Array<[LogicalSecret, string, string | undefined]> = [
      ['github-app-private-key', args.pem, undefined],
      ['github-app-id', args.appId, 'GITHUB_APP_ID'],
      ['github-webhook-secret', args.webhookSecret, 'GITHUB_WEBHOOK_SECRET'],
      ['github-oauth-client-id', args.oauthClientId, 'GITHUB_OAUTH_CLIENT_ID'],
      ['github-oauth-client-secret', args.oauthClientSecret, 'GITHUB_OAUTH_CLIENT_SECRET'],
    ];
    for (const [name, value, envVar] of writes) {
      if (!value) continue;
      try {
        await store.write(name, value);
      } catch (err) {
        const container = store instanceof GsmSecretStore ? store.containerFor(name) : String(name);
        throw new Error(
          `GSM persistence failed for "${container}": ${(err as Error).message}. ` +
            `The GitHub App was created and the key is on disk at ${args.keyPath} — ` +
            `fix the pod's Secret Manager IAM and re-run the wizard, or upload the value manually.`,
        );
      }
      // The running process sees fresh values immediately — no ESO
      // round-trip (feature secrets aren't ESO-synced at all anymore).
      if (envVar) process.env[envVar] = value;
    }
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = args.keyPath;
  }

  // Drop expired state tokens AND unclaimed pending-instance entries.
  // Called opportunistically — bounded by the rate at which states are
  // issued/consumed; no separate timer.
  private gc(): void {
    const now = Date.now();
    const stateCutoff = now - STATE_TTL_MS;
    for (const [token, entry] of this.states) {
      if (entry.createdAt < stateCutoff) this.states.delete(token);
    }
    const pendingCutoff = now - PENDING_TTL_MS;
    for (const [nonce, entry] of this.pendingInstance) {
      if (entry.createdAt < pendingCutoff) this.pendingInstance.delete(nonce);
    }
  }
}

// Return a human-readable reason if the given URL would be rejected by
// GitHub as a webhook target (not publicly reachable). Returns null when
// the URL looks public enough that we can include it in the manifest.
//
// This isn't perfectly accurate — a hostname could resolve to a public
// IP that's actually internal — but it catches the common local-dev
// cases (localhost / 127.x / 192.168.x / 10.x / 172.16-31.x / ::1) that
// hard-fail GitHub's manifest validator. Borderline cases get sent to
// GitHub; if GitHub rejects, the user sees the error directly.
export function checkWebhookUrlPublic(rawUrl: string): string | null {
  if (!rawUrl || !rawUrl.trim()) return 'no webhook URL configured';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'webhook URL is not a valid URL';
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'webhook URL points at localhost';
  }
  if (host === '127.0.0.1' || host.startsWith('127.')) return 'webhook URL is loopback (127.x)';
  if (host === '::1') return 'webhook URL is IPv6 loopback (::1)';
  if (host === '0.0.0.0') return 'webhook URL is the wildcard 0.0.0.0';
  // RFC1918 private ranges — GitHub can't reach these from the internet.
  if (host.startsWith('10.')) return 'webhook URL is in the private 10.x range';
  if (host.startsWith('192.168.')) return 'webhook URL is in the private 192.168.x range';
  const m172 = host.match(/^172\.(\d+)\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return 'webhook URL is in the private 172.16/12 range';
  }
  return null;
}

// Re-exported for tests that need to bypass the JS-host's `fs` boundary
// (e.g. by passing a tmpdir keyDir + a mock fetch).
export { dirname };
