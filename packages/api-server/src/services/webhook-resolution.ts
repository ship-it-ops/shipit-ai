// Webhook routing + secret resolution for the GitHub webhook receiver.
//
// Two concerns, both consumed only by routes/webhooks.ts:
//   1. installation.id -> connector(s) routing (which connector owns a
//      delivery), built per-request from the registry so it can't go stale.
//   2. which webhook secret verifies a delivery, with a HARD downgrade guard:
//      a per-org (App-overridden) connector NEVER falls back to the global
//      secret. See INV-3 in docs/agent/plans/github-webhook-receiver.md.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { resolveAppCredentials, type AppLike, type GitHubConnectorConfig } from '@shipit-ai/shared';
import type { ConnectorRegistry } from './connector-registry.js';

// ── installation.id -> connector index (T3) ───────────────────────────────

// Build a fresh installation.id -> GitHub connectors index from the registry.
// Per-request (the registry list is small and in-memory) so the index can
// never be stale — no cache, no invalidation plumbing. GitHub webhook payloads
// carry installation.id as a NUMBER; connector config stores installationId as
// a STRING, so we key by string and coerce on lookup. Multiple connectors can
// in principle share an installation, so the value is a list.
export function buildInstallationIndex(
  registry: ConnectorRegistry,
): Map<string, GitHubConnectorConfig[]> {
  const index = new Map<string, GitHubConnectorConfig[]>();
  for (const c of registry.list()) {
    if (c.type !== 'github') continue;
    const gh = c as GitHubConnectorConfig;
    const key = String(gh.installationId).trim();
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(gh);
    else index.set(key, [gh]);
  }
  return index;
}

// Resolve the GitHub connector(s) backing a delivery's installation id. The id
// comes from the UNVERIFIED payload (number or string) and is used only to
// select candidate secrets — verification still happens before any state
// change. An empty array means "unknown installation": the caller MUST 202 +
// alert and MUST NOT fall back to any global secret (downgrade guard, INV-3).
export function resolveConnectorsByInstallation(
  registry: ConnectorRegistry,
  installationId: number | string | undefined | null,
): GitHubConnectorConfig[] {
  if (installationId === undefined || installationId === null) return [];
  const key = String(installationId).trim();
  if (!key) return [];
  return buildInstallationIndex(registry).get(key) ?? [];
}

// ── webhook secret resolution (T4) ─────────────────────────────────────────

export type WebhookSecretSource = 'per-app' | 'global' | 'none';

export interface ResolvedWebhookSecret {
  secret: string | null;
  source: WebhookSecretSource;
  appId: string | null;
  // Distinguishes the "none" reasons so logs separate a misconfig
  // (should-exist-but-missing) from absent-by-design.
  reason?: 'no-app-id' | 'per-app-missing' | 'global-empty';
}

function keyDirFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = (env.SHIPIT_GITHUB_APP_KEY_DIR ?? join(homedir(), '.shipit', 'keys')).trim();
  return isAbsolute(raw) ? raw : resolvePath(raw);
}

// Per-App secret cache keyed by sidecar path, invalidated by file mtime. The
// webhook route is unthrottled (HMAC is the gate) and resolves the secret on
// EVERY delivery BEFORE verification, so an uncached readFileSync per request is
// a pre-auth amplification vector. Caching by mtime removes the content read
// from the hot path while keeping rotation immediate: a rewrite changes mtime →
// cache miss → re-read. statSync remains (cheap; page-cached inode).
const perAppSecretCache = new Map<string, { mtimeMs: number; secret: string | null }>();

// The per-App sidecar written at boot by ConnectorAppStore.loadAndMaterialize
// (and by the manifest flow): <keyDir>/github-app-<appId>.webhook-secret, with
// a trailing newline. Read + trim; returns null when absent/empty.
function readPerAppSecret(appId: string, env: NodeJS.ProcessEnv): string | null {
  const path = join(keyDirFromEnv(env), `github-app-${appId}.webhook-secret`);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    perAppSecretCache.delete(path);
    return null; // no sidecar present
  }
  const cached = perAppSecretCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.secret;
  const raw = readFileSync(path, 'utf-8').trim();
  const secret = raw.length > 0 ? raw : null;
  perAppSecretCache.set(path, { mtimeMs, secret });
  return secret;
}

// Resolve the webhook secret used to verify a delivery for a given connector.
//
// Security (INV-3 — no downgrade):
//   - A per-App sidecar secret is preferred when present (works for both the
//     global App and a per-org App; it is materialized at boot from the GSM
//     connector-apps blob).
//   - A connector that OVERRIDES the App (per-org) and has NO sidecar secret
//     returns {source:'none'} — it NEVER falls back to the global env secret,
//     because accepting a per-org delivery under the shared secret is a
//     downgrade.
//   - Only a connector on the GLOBAL App legitimately uses
//     GITHUB_WEBHOOK_SECRET.
export function resolveWebhookSecret(
  connector: GitHubConnectorConfig,
  globalApp: AppLike,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWebhookSecret {
  const resolved = resolveAppCredentials(connector, globalApp);
  const appId = resolved.id;

  if (appId) {
    const perApp = readPerAppSecret(appId, env);
    if (perApp) return { secret: perApp, source: 'per-app', appId };
  }

  // No per-App secret. Only a non-overridden (global-App) connector may use
  // the global env secret; an overridden connector must not downgrade.
  if (!resolved.overridden) {
    const globalSecret = (env.GITHUB_WEBHOOK_SECRET ?? '').trim();
    if (globalSecret) return { secret: globalSecret, source: 'global', appId };
    return { secret: null, source: 'none', appId, reason: 'global-empty' };
  }

  return {
    secret: null,
    source: 'none',
    appId,
    reason: appId ? 'per-app-missing' : 'no-app-id',
  };
}
