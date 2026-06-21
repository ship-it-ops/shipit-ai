// Backing service for the admin Portal Settings hub (routes/portal-settings.ts).
//
// Centralizes the secret-writing + last-verified-reading logic so the routes
// stay thin and every secret mutation lives in one auditable place (tradeoff
// option A in docs/agent/plans/admin-portal-settings.md). It holds live
// references to the same stores/registry/global-App object the rest of the
// server uses, so a write here is visible to the receiver + scheduler without a
// restart.
//
// Secrets are NEVER logged from this service. The webhook secret IS returned to
// the admin caller by design (the portal is the source of truth — the admin
// pastes it into the GitHub App), but it never lands in a log line.
import { randomBytes } from 'node:crypto';
import { resolveAppCredentials, type AppLike, type GitHubConnectorConfig } from '@shipit-ai/shared';
import type { ConnectorAppStore } from './connector-app-store.js';
import type { ConnectorRegistry } from './connector-registry.js';
import { resolveWebhookSecret } from './webhook-resolution.js';
import type { SecretStore } from '../secrets/types.js';
import type { WebhookRefetchPort } from '../routes/webhooks.js';

// Same permissive shape used by SetupService — catch typos, not enforce RFC.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface WebhookSecretResult {
  secret: string;
  webhookUrl: string;
  steps: string[];
}

export interface SettingsServiceOptions {
  secretStore: SecretStore;
  // Live reference to config.connectors.github.app — the same object
  // GitHubAppService mutates and the scheduler/receiver read. Carries
  // { id?, privateKeyPath?, webhookSecret?, webhookPublicUrl? }.
  globalApp: AppLike & { webhookSecret?: string; webhookPublicUrl?: string };
  registry: ConnectorRegistry;
  connectorAppStore: ConnectorAppStore;
  webhookRefetch?: WebhookRefetchPort;
  env?: NodeJS.ProcessEnv;
}

// Thrown when a webhook-secret rotate is requested for a connector that has no
// resolvable GitHub App id (so there's nowhere to anchor a per-App secret). The
// route maps this to a 400.
export class NoResolvableAppError extends Error {
  constructor(connectorId: string) {
    super(
      `Connector "${connectorId}" has no resolvable GitHub App id — configure the global App ` +
        `or a per-connector app.id before generating a webhook secret.`,
    );
    this.name = 'NoResolvableAppError';
  }
}

export class InvalidAllowlistEmailError extends Error {
  constructor(email: string) {
    super(`"${email}" is not a valid email address.`);
    this.name = 'InvalidAllowlistEmailError';
  }
}

export class SettingsService {
  private readonly secretStore: SecretStore;
  private readonly globalApp: AppLike & { webhookSecret?: string; webhookPublicUrl?: string };
  private readonly registry: ConnectorRegistry;
  private readonly connectorAppStore: ConnectorAppStore;
  private readonly webhookRefetch?: WebhookRefetchPort;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: SettingsServiceOptions) {
    this.secretStore = opts.secretStore;
    this.globalApp = opts.globalApp;
    this.registry = opts.registry;
    this.connectorAppStore = opts.connectorAppStore;
    this.webhookRefetch = opts.webhookRefetch;
    this.env = opts.env ?? process.env;
  }

  // Generate + persist a fresh webhook secret for a connector's GitHub App and
  // return it (plus the receiver URL + paste-into-GitHub steps) to the admin.
  // setup vs rotate are the same operation.
  //
  //   - Per-org (App-overridden) connector → write the per-App sidecar + re-sync
  //     the connector-apps blob (so it survives restart). NEVER touches the
  //     global secret (no downgrade).
  //   - Global-App connector → write github-webhook-secret + set the env so the
  //     receiver verifies the next delivery immediately (manifest-service
  //     precedent — GitHubAppService.update deliberately won't touch it).
  async setConnectorWebhookSecret(connectorId: string): Promise<WebhookSecretResult> {
    const connector = this.registry.get(connectorId) as GitHubConnectorConfig;
    const resolved = resolveAppCredentials(connector, this.globalApp);
    if (!resolved.id) {
      throw new NoResolvableAppError(connectorId);
    }
    const appId = resolved.id;

    // 256 bits of entropy, hex-encoded — same shape GitHub recommends for a
    // webhook secret.
    const secret = randomBytes(32).toString('hex');

    if (resolved.overridden) {
      // Per-org App: the sidecar (and the connector-apps blob it re-syncs into)
      // is the durable home. The registry list is the full connector set the
      // blob mirrors.
      await this.connectorAppStore.setWebhookSecret(appId, secret, this.registry.list());
    } else {
      // Global App: GSM container + in-process env so the receiver picks it up
      // on the very next delivery without a restart.
      await this.secretStore.write('github-webhook-secret', secret);
      this.env.GITHUB_WEBHOOK_SECRET = secret;
    }

    return {
      secret,
      webhookUrl: this.globalApp.webhookPublicUrl ?? '',
      steps: this.webhookSetupSteps(secret),
    };
  }

  // Numbered, copy-pasteable GitHub-App webhook setup instructions for the admin
  // browser. The secret is embedded so the admin can paste both URL + secret in
  // one pass; this string is returned to the (admin-only) caller, never logged.
  private webhookSetupSteps(secret: string): string[] {
    const url = this.globalApp.webhookPublicUrl ?? '<your webhook URL>';
    return [
      'Open your GitHub App settings (Settings → Developer settings → GitHub Apps → your app).',
      'In the "Webhook" section, ensure "Active" is checked.',
      `Set the Webhook URL to: ${url}`,
      `Set the Webhook secret to: ${secret}`,
      'Set "Content type" to application/json.',
      'Save changes, then use "Recent Deliveries" → "Redeliver" (or push a commit) to verify.',
    ];
  }

  // Replace the login allow-list. Validates each email, then writes the GSM
  // container + sets the env so the auth layer sees the new list this process.
  async setAllowlist(emails: string[]): Promise<void> {
    const trimmed = emails.map((e) => e.trim()).filter((e) => e.length > 0);
    for (const email of trimmed) {
      if (!EMAIL_RE.test(email)) {
        throw new InvalidAllowlistEmailError(email);
      }
    }
    const csv = trimmed.join(',');
    await this.secretStore.write('auth-allow-list-emails', csv);
    this.env.SHIPIT_AUTH_ALLOWLIST = csv;
  }

  // Current allow-list from the env (CSV). Empty array when unset.
  getAllowlist(): string[] {
    return this.csvFromEnv(this.env.SHIPIT_AUTH_ALLOWLIST);
  }

  // Current admin list from the env (CSV), falling back to the committed config
  // when the env hasn't been set (e.g. admins came from shipit.config.yaml).
  getAdmins(configAdmins: string[] = []): string[] {
    const fromEnv = this.csvFromEnv(this.env.SHIPIT_AUTH_ADMINS);
    return fromEnv.length > 0 ? fromEnv : [...configAdmins];
  }

  // Whether the login OAuth client is configured (both id + secret present).
  getOAuthConfigured(): boolean {
    return Boolean(this.env.GITHUB_OAUTH_CLIENT_ID && this.env.GITHUB_OAUTH_CLIENT_SECRET);
  }

  // The receiver URL shown across the settings UI.
  getWebhookUrl(): string {
    return this.globalApp.webhookPublicUrl ?? '';
  }

  // Per-connector webhook view rows for GET /api/settings.
  async listWebhooks(): Promise<
    Array<{
      connectorId: string;
      appId: string | null;
      org: string | null;
      secretConfigured: boolean;
      lastVerifiedDelivery: { event: string; deliveryId: string; ts: string } | null;
    }>
  > {
    const rows: Array<{
      connectorId: string;
      appId: string | null;
      org: string | null;
      secretConfigured: boolean;
      lastVerifiedDelivery: { event: string; deliveryId: string; ts: string } | null;
    }> = [];
    for (const c of this.registry.list()) {
      if (c.type !== 'github') continue;
      const gh = c as GitHubConnectorConfig;
      const resolved = resolveWebhookSecret(gh, this.globalApp, this.env);
      const lastVerifiedDelivery = this.webhookRefetch
        ? await this.webhookRefetch.getLastVerifiedDelivery(gh.id)
        : null;
      rows.push({
        connectorId: gh.id,
        appId: resolved.appId,
        org: gh.org ?? null,
        secretConfigured: resolved.secret != null,
        lastVerifiedDelivery,
      });
    }
    return rows;
  }

  private csvFromEnv(value: string | undefined): string[] {
    if (!value) return [];
    return value
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
  }
}
