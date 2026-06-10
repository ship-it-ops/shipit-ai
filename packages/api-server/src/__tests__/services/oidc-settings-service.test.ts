import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { OidcSettingsService } from '../../services/auth/oidc-settings-service.js';
import { FileSecretStore } from '../../secrets/file-store.js';
import { makeTestConfig } from '../test-config.js';

describe('OidcSettingsService', () => {
  let tmpDir: string;
  let localPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-oidc-'));
    localPath = join(tmpDir, 'shipit.config.local.yaml');
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('persists secret via store, identifiers via local YAML, and mutates live config', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const config = makeTestConfig();
    const svc = new OidcSettingsService({
      localConfigPath: localPath,
      authConfig: config.accessControl.auth,
      secretStore: new FileSecretStore(env),
      env,
    });

    await svc.update({
      issuerUrl: 'https://idp.example.com',
      clientId: 'shipit-client',
      clientSecret: 'super-secret',
    });

    // Secret: store + current-process env, never YAML.
    expect(env.OIDC_CLIENT_SECRET).toBe('super-secret');
    const yaml = parseYaml(readFileSync(localPath, 'utf-8'));
    expect(JSON.stringify(yaml)).not.toContain('super-secret');
    // Identifiers + wiring in YAML.
    expect(yaml.accessControl.auth.providers.oidc).toMatchObject({
      enabled: true,
      issuerUrl: 'https://idp.example.com',
      clientId: 'shipit-client',
      clientSecretEnv: 'OIDC_CLIENT_SECRET',
    });
    // Live reference updated in place (same pattern as GitHubAppService).
    expect(config.accessControl.auth.providers.oidc.enabled).toBe(true);
    expect(config.accessControl.auth.providers.oidc.issuerUrl).toBe('https://idp.example.com');
  });

  it('rejects missing fields with statusCode 400', async () => {
    const svc = new OidcSettingsService({
      localConfigPath: localPath,
      authConfig: makeTestConfig().accessControl.auth,
      secretStore: new FileSecretStore({} as NodeJS.ProcessEnv),
      env: {} as NodeJS.ProcessEnv,
    });
    await expect(
      svc.update({ issuerUrl: '', clientId: 'x', clientSecret: 'y' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps the existing secret when clientSecret is omitted (edit identifiers only)', async () => {
    const env = { OIDC_CLIENT_SECRET: 'existing' } as NodeJS.ProcessEnv;
    const svc = new OidcSettingsService({
      localConfigPath: localPath,
      authConfig: makeTestConfig().accessControl.auth,
      secretStore: new FileSecretStore(env),
      env,
    });
    await svc.update({ issuerUrl: 'https://idp.example.com', clientId: 'cid' });
    expect(env.OIDC_CLIENT_SECRET).toBe('existing');
  });
});
