// Boot-time hydration: pull GSM values into the places the app already
// reads secrets from (process.env + a PEM file on disk), BEFORE
// loadConfig() runs so ${GITHUB_APP_ID:-}-style substitutions in the
// chart-seeded config resolve. This is what keeps every existing
// consumer (server.ts env reads, resolveAppCredentials/privateKeyPath)
// untouched — only write paths know the store exists.
//
// Pre-set env vars always win (operator overrides). ADC/permission
// errors propagate so a misconfigured Workload Identity fails the boot
// loudly instead of silently starting an empty instance; a missing
// secret version is just first-run and hydrates as "not set".
import { chmodSync, writeFileSync } from 'node:fs';
import { ensureKeyDir } from './key-dir.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SecretsRegistry } from '@shipit-ai/shared';
import { ResolvedSecrets } from './resolved.js';
import type { SecretStore } from './types.js';

// These keys are mutated at runtime by SettingsService / setup wizard
// (write-through to env after persisting to GSM), so the accessor reads
// them live from env rather than the boot snapshot.
export const LIVE_ENV_KEYS: Record<string, string> = {
  'auth-admin-emails': 'SHIPIT_AUTH_ADMINS',
  'auth-allow-list-emails': 'SHIPIT_AUTH_ALLOWLIST',
  'github-webhook-secret': 'GITHUB_WEBHOOK_SECRET',
  // The setup wizard's setOAuthClient() writes these mid-session; status()/
  // complete() must see them without a restart.
  'github-oauth-client-id': 'GITHUB_OAUTH_CLIENT_ID',
  'github-oauth-client-secret': 'GITHUB_OAUTH_CLIENT_SECRET',
  // OidcSettingsService writes through env after persisting to GSM; its
  // has-existing-secret check must see the write without a restart.
  'oidc-client-secret': 'OIDC_CLIENT_SECRET',
};

// Fallback accessor for surfaces constructed without a boot-hydration
// accessor (unit tests; services whose secret needs are all env-carried).
// Post-hydration the env vars hold the effective values by construction,
// so an env view is behavior-identical to the real accessor for these keys.
// session-secret is included (env-carried, operator-set) even though it is
// not runtime-mutable.
const ENV_VIEW_KEYS: Record<string, string> = {
  ...LIVE_ENV_KEYS,
  'session-secret': 'SHIPIT_SESSION_SECRET',
};

export function envSecretsView(env: NodeJS.ProcessEnv = process.env): ResolvedSecrets {
  return new ResolvedSecrets(new Map(), ENV_VIEW_KEYS, env);
}

export async function hydrateSecrets(
  store: SecretStore,
  registry: SecretsRegistry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ resolved: ResolvedSecrets; hydrated: string[]; pemPath: string | null }> {
  const hydrated: string[] = [];
  const snapshot = new Map<string, string>();

  // ── Pass 1: consume:env and consume:store-only ───────────────────────────
  // Order matters: github-app-id must hydrate before the PEM (Pass 2) so the
  // materialized file can carry the github-app-<id>.pem name the rest of
  // the wizard tooling uses.
  for (const [key, entry] of Object.entries(registry)) {
    if (entry.consume === 'env') {
      // Pre-set env wins AND the store is not consulted for it. This matters
      // beyond efficiency: ESO-delivered bootstrap secrets (NEO4J_PASSWORD,
      // SHIPIT_SESSION_SECRET) reach the pod via a k8s Secret → envFrom, and
      // the api-server GSA deliberately holds NO secretAccessor grant on those
      // containers — reading them from GSM throws PERMISSION_DENIED and
      // crashed boot on the 2026-09-16 sha-e30da0f deploy.
      // No-clobber: empty-string env (e.g. a placeholder GITHUB_APP_ID="" from
      // a chart ConfigMap) counts as unset and gets filled from GSM.
      // Do NOT change this to === undefined.
      const preset = entry.env ? env[entry.env] : undefined;
      if (!preset) {
        const value = await store.read(key);
        if (value != null && entry.env) env[entry.env] = value;
      }
      // Snapshot the EFFECTIVE env value so resolved.get() returns whatever the
      // process will actually use — operator-pre-set wins over GSM, and that
      // pre-set value must be visible through the accessor even when GSM returns null.
      const effective = entry.env ? env[entry.env] : undefined;
      if (effective && effective.length > 0) {
        snapshot.set(key, effective);
        hydrated.push(key);
      }
    }
    // consume:store-only — do NOT touch env, do NOT snapshot.
    // (intentional skip for 'file' — handled in Pass 2)
  }

  // ── Pass 2: consume:file (PEM materialization) ───────────────────────────
  // Only in gsm mode: the PEM is path-based in local/file mode.
  let pemPath: string | null = null;
  for (const [key, entry] of Object.entries(registry)) {
    if (entry.consume !== 'file') continue;

    if (store.kind !== 'gsm') continue; // skip PEM materialization outside gsm

    const pem = await store.read(key);
    if (pem !== null) {
      hydrated.push(key);
      const keyDir = env.SHIPIT_GITHUB_APP_KEY_DIR || join(homedir(), '.shipit', 'keys');
      ensureKeyDir(keyDir);
      const appId = env.GITHUB_APP_ID;
      const filename = appId ? `github-app-${appId}.pem` : 'github-app.pem';
      pemPath = join(keyDir, filename);
      // Exact bytes — the PEM round-trip contract. mode 0600 like the
      // manifest service's own writes. Unlike the env vars, the FILE is
      // rewritten on every boot on purpose: a key rotated in GSM must land
      // on disk; only the env-var pointer gets no-clobber treatment.
      writeFileSync(pemPath, pem, { encoding: 'utf-8', mode: 0o600 });
      chmodSync(pemPath, 0o600);
      if (entry.filePathEnv && !env[entry.filePathEnv]) env[entry.filePathEnv] = pemPath;
    }
  }

  // ── Required fail-fast (gsm mode only) ───────────────────────────────────
  // In local/file mode, skip so dev machines without full GSM access still boot.
  if (store.kind === 'gsm') {
    for (const [key, entry] of Object.entries(registry)) {
      if (!entry.required) continue;
      // A required secret is satisfied if: snapshotted (consume:env), or env
      // is already set (operator pre-set), or filePathEnv is set (consume:file).
      const envVar = entry.env ?? entry.filePathEnv;
      const satisfied = snapshot.has(key) || (envVar ? Boolean(env[envVar]) : false);
      if (!satisfied) {
        throw new Error(
          `Required secret "${key}" (GSM container: "${entry.gsmContainer}") is not available. ` +
            `Ensure the secret has a version in Secret Manager before starting the server.`,
        );
      }
    }
  }

  const resolved = new ResolvedSecrets(snapshot, LIVE_ENV_KEYS, env);
  return { resolved, hydrated, pemPath };
}
