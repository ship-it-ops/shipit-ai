// Persists OIDC provider settings entered through the web-UI: the client
// secret goes to the SecretStore (GSM in prod — durable across pod
// restarts) + the current process env; the public identifiers go to
// shipit.config.local.yaml using the same parseDocument + atomic-rename
// pattern as GitHubAppService. The secret NEVER lands in YAML (secretlint
// and the schema's env-name-only convention both forbid it).
//
// Providers are constructed once at server boot (server.ts), so changes
// here take effect on the next restart. On GKE that restart re-hydrates
// the secret from GSM — that's the durable path this service feeds.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import type { Config } from '@shipit-ai/shared';
import type { SecretStore } from '../../secrets/types.js';

type AuthConfig = Config['accessControl']['auth'];

export interface OidcSettingsInput {
  issuerUrl: string;
  clientId: string;
  // Omitted = keep the existing secret (identifier-only edit).
  clientSecret?: string;
}

export interface OidcSettingsServiceOptions {
  localConfigPath: string;
  // Live reference to config.accessControl.auth — mutated in place.
  authConfig: AuthConfig;
  secretStore: SecretStore;
  env?: NodeJS.ProcessEnv;
}

export class OidcSettingsService {
  private localConfigPath: string;
  private authConfig: AuthConfig;
  private secretStore: SecretStore;
  private env: NodeJS.ProcessEnv;

  constructor(opts: OidcSettingsServiceOptions) {
    this.localConfigPath = opts.localConfigPath;
    this.authConfig = opts.authConfig;
    this.secretStore = opts.secretStore;
    this.env = opts.env ?? process.env;
  }

  async update(input: OidcSettingsInput): Promise<{ restartRequired: boolean }> {
    const issuerUrl = input.issuerUrl?.trim() ?? '';
    const clientId = input.clientId?.trim() ?? '';
    if (!issuerUrl || !clientId) {
      throw Object.assign(new Error('issuerUrl and clientId are required'), { statusCode: 400 });
    }
    // Reject a malformed issuer early: this value is persisted with
    // oidc.enabled=true and the next boot builds OidcProvider from it, so a
    // bad paste would brick startup until the local YAML is hand-edited —
    // exactly the manual step this endpoint exists to remove. https is
    // required except for loopback hosts (local-dev IdPs like Keycloak on
    // http://localhost), mirroring checkWebhookUrlPublic's pragmatism.
    let parsedIssuer: URL;
    try {
      parsedIssuer = new URL(issuerUrl);
    } catch {
      throw Object.assign(new Error('issuerUrl must be a valid URL'), { statusCode: 400 });
    }
    const issuerHost = parsedIssuer.hostname.toLowerCase();
    const isLoopback =
      issuerHost === 'localhost' ||
      issuerHost.endsWith('.localhost') ||
      issuerHost.startsWith('127.') ||
      issuerHost === '::1' ||
      issuerHost === '[::1]';
    if (parsedIssuer.protocol !== 'https:' && !isLoopback) {
      throw Object.assign(
        new Error('issuerUrl must use https (http is allowed only for loopback hosts)'),
        {
          statusCode: 400,
        },
      );
    }
    const hasExistingSecret = Boolean(this.env.OIDC_CLIENT_SECRET);
    const clientSecret = input.clientSecret?.trim();
    if (!clientSecret && !hasExistingSecret) {
      throw Object.assign(
        new Error('clientSecret is required (no existing OIDC client secret is configured)'),
        { statusCode: 400 },
      );
    }

    if (clientSecret) {
      await this.secretStore.write('oidc-client-secret', clientSecret);
      this.env.OIDC_CLIENT_SECRET = clientSecret;
    }

    this.persistIdentifiers({ issuerUrl, clientId });

    const oidc = this.authConfig.providers.oidc;
    oidc.enabled = true;
    oidc.issuerUrl = issuerUrl;
    oidc.clientId = clientId;
    if (!oidc.clientSecretEnv) oidc.clientSecretEnv = 'OIDC_CLIENT_SECRET';

    // Provider objects are built at boot; a restart picks these up (and
    // on GKE re-hydrates the secret from GSM).
    return { restartRequired: true };
  }

  private persistIdentifiers(values: { issuerUrl: string; clientId: string }): void {
    const raw = existsSync(this.localConfigPath) ? readFileSync(this.localConfigPath, 'utf-8') : '';
    const doc = raw.trim() ? parseDocument(raw) : parseDocument('');
    const base = ['accessControl', 'auth', 'providers', 'oidc'];
    doc.setIn([...base, 'enabled'], true);
    doc.setIn([...base, 'issuerUrl'], values.issuerUrl);
    doc.setIn([...base, 'clientId'], values.clientId);
    doc.setIn([...base, 'clientSecretEnv'], 'OIDC_CLIENT_SECRET');
    const next = String(doc);
    const tmp = join(
      dirname(this.localConfigPath),
      `.${process.pid}.${Date.now()}.shipit-oidc.tmp`,
    );
    writeFileSync(tmp, next, 'utf-8');
    renameSync(tmp, this.localConfigPath);
  }
}
