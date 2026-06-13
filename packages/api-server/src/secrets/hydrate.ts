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
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENV_VAR_FOR, type LogicalSecret, type SecretStore } from './types.js';

// Order matters: github-app-id must hydrate before the PEM so the
// materialized file can carry the github-app-<id>.pem name the rest of
// the wizard tooling uses.
const ENV_HYDRATED: LogicalSecret[] = [
  'github-app-id',
  'github-oauth-client-id',
  'github-webhook-secret',
  'github-oauth-client-secret',
  'oidc-client-secret',
  'auth-admin-emails',
  'auth-allow-list-emails',
];

export interface HydrationResult {
  hydrated: LogicalSecret[];
  pemPath: string | null;
}

export async function hydrateFromStore(
  store: SecretStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HydrationResult> {
  if (store.kind !== 'gsm') return { hydrated: [], pemPath: null };

  const hydrated: LogicalSecret[] = [];
  for (const name of ENV_HYDRATED) {
    const value = await store.read(name);
    if (value === null) continue;
    hydrated.push(name);
    const envVar = ENV_VAR_FOR[name]!;
    // Falsy check is deliberate: empty-string env (e.g. a placeholder
    // GITHUB_APP_ID="" from the chart ConfigMap) counts as unset and gets
    // filled from GSM. Do not "fix" this to === undefined.
    if (!env[envVar]) env[envVar] = value;
  }

  let pemPath: string | null = null;
  const pem = await store.read('github-app-private-key');
  if (pem !== null) {
    hydrated.push('github-app-private-key');
    const keyDir = env.SHIPIT_GITHUB_APP_KEY_DIR || join(homedir(), '.shipit', 'keys');
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const appId = env.GITHUB_APP_ID;
    pemPath = join(keyDir, appId ? `github-app-${appId}.pem` : 'github-app.pem');
    // Exact bytes — the PEM round-trip contract. mode 0600 like the
    // manifest service's own writes. Unlike the env vars, the FILE is
    // rewritten on every boot on purpose: a key rotated in GSM must land
    // on disk; only the env-var pointer gets no-clobber treatment.
    writeFileSync(pemPath, pem, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(pemPath, 0o600);
    if (!env.GITHUB_APP_PRIVATE_KEY_PATH) env.GITHUB_APP_PRIVATE_KEY_PATH = pemPath;
  }

  return { hydrated, pemPath };
}
