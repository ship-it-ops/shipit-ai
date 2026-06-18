import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppLike, GitHubConnectorConfig } from '@shipit-ai/shared';
import type { ConnectorRegistry } from '../../services/connector-registry.js';
import {
  buildInstallationIndex,
  resolveConnectorsByInstallation,
  resolveWebhookSecret,
} from '../../services/webhook-resolution.js';

// Minimal GitHub connector literal — the resolution helpers only read type,
// installationId, and app, so we cast a partial rather than fill the schema.
function ghConnector(over: Partial<GitHubConnectorConfig> = {}): GitHubConnectorConfig {
  return {
    id: over.id ?? 'c1',
    type: 'github',
    enabled: true,
    name: over.name ?? 'C1',
    installationId: over.installationId ?? '1001',
    org: over.org ?? 'acme',
    app: over.app,
  } as GitHubConnectorConfig;
}

// A registry stand-in: the helpers only call list().
function fakeRegistry(connectors: GitHubConnectorConfig[]): ConnectorRegistry {
  return { list: () => connectors } as unknown as ConnectorRegistry;
}

describe('buildInstallationIndex / resolveConnectorsByInstallation', () => {
  it('keys connectors by string installationId and skips non-github', () => {
    const reg = fakeRegistry([
      ghConnector({ id: 'a', installationId: '1001' }),
      ghConnector({ id: 'b', installationId: '2002' }),
      { id: 'x', type: 'gitlab' } as unknown as GitHubConnectorConfig,
    ]);
    const index = buildInstallationIndex(reg);
    expect([...index.keys()].sort()).toEqual(['1001', '2002']);
    expect(index.get('1001')!.map((c) => c.id)).toEqual(['a']);
  });

  it('coerces a numeric payload installation.id to the string key', () => {
    const reg = fakeRegistry([ghConnector({ id: 'a', installationId: '1001' })]);
    expect(resolveConnectorsByInstallation(reg, 1001).map((c) => c.id)).toEqual(['a']);
    expect(resolveConnectorsByInstallation(reg, '1001').map((c) => c.id)).toEqual(['a']);
  });

  it('groups multiple connectors that share an installation', () => {
    const reg = fakeRegistry([
      ghConnector({ id: 'a', installationId: '1001' }),
      ghConnector({ id: 'b', installationId: '1001' }),
    ]);
    expect(resolveConnectorsByInstallation(reg, 1001).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('returns [] for an unknown, null, or undefined installation id', () => {
    const reg = fakeRegistry([ghConnector({ installationId: '1001' })]);
    expect(resolveConnectorsByInstallation(reg, 9999)).toEqual([]);
    expect(resolveConnectorsByInstallation(reg, null)).toEqual([]);
    expect(resolveConnectorsByInstallation(reg, undefined)).toEqual([]);
  });
});

describe('resolveWebhookSecret', () => {
  let keyDir: string;
  let env: NodeJS.ProcessEnv;
  const globalApp: AppLike = { id: 'global-app', privateKeyPath: '/keys/global.pem' };

  beforeEach(() => {
    keyDir = mkdtempSync(join(tmpdir(), 'wh-secret-'));
    env = { SHIPIT_GITHUB_APP_KEY_DIR: keyDir } as NodeJS.ProcessEnv;
  });
  afterEach(() => {
    rmSync(keyDir, { recursive: true, force: true });
  });

  function writeSidecar(appId: string, value: string): void {
    // Materialized with a trailing newline, exactly like ConnectorAppStore.
    writeFileSync(join(keyDir, `github-app-${appId}.webhook-secret`), value + '\n');
  }

  it('prefers the per-App sidecar secret (trimmed) for a global-App connector', () => {
    writeSidecar('global-app', 's3cr3t');
    const r = resolveWebhookSecret(ghConnector(), globalApp, env);
    expect(r).toEqual({ secret: 's3cr3t', source: 'per-app', appId: 'global-app' });
  });

  it('uses the per-App sidecar for a per-org (overridden) connector', () => {
    writeSidecar('org-app', 'orgsecret');
    const c = ghConnector({ app: { id: 'org-app', privateKeyPath: '/keys/org.pem' } });
    const r = resolveWebhookSecret(c, globalApp, env);
    expect(r).toEqual({ secret: 'orgsecret', source: 'per-app', appId: 'org-app' });
  });

  it('falls back to GITHUB_WEBHOOK_SECRET only for a global-App connector', () => {
    env.GITHUB_WEBHOOK_SECRET = 'globalsecret';
    const r = resolveWebhookSecret(ghConnector(), globalApp, env);
    expect(r).toEqual({ secret: 'globalsecret', source: 'global', appId: 'global-app' });
  });

  // INV-3: the downgrade guard. A per-org connector with no sidecar must NOT
  // accept the global secret even when one is present in the environment.
  it('NEVER downgrades a per-org connector to the global secret', () => {
    env.GITHUB_WEBHOOK_SECRET = 'globalsecret';
    const c = ghConnector({ app: { id: 'org-app', privateKeyPath: '/keys/org.pem' } });
    const r = resolveWebhookSecret(c, globalApp, env);
    expect(r.secret).toBeNull();
    expect(r.source).toBe('none');
    expect(r.reason).toBe('per-app-missing');
  });

  it('returns none/global-empty when a global-App connector has neither sidecar nor env', () => {
    const r = resolveWebhookSecret(ghConnector(), globalApp, env);
    expect(r).toEqual({
      secret: null,
      source: 'none',
      appId: 'global-app',
      reason: 'global-empty',
    });
  });
});
