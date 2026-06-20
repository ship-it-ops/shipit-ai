/**
 * REAL-GCP integration test for hydrateFromStore (#5, integration-test roadmap).
 *
 * hydrate.test.ts exercises the loop with a fake store. The boot-critical reality
 * it can't prove: a real GSM read populates process.env AND materializes the PEM to
 * disk with EXACT bytes and 0o600. This drives the full boot-hydration step through a
 * real GsmSecretStore (real accessSecretVersion) and a real filesystem write.
 *
 * Gated on GSM_TEST_PROJECT (skips by default). Same creds/run instructions as
 * gsm-store.integration.test.ts.
 *
 * ISOLATION FROM PRODUCTION SECRETS: hydrate reads EVERY logical secret in its list.
 * Against a real project those default to the Terraform-managed shipit-* containers.
 * So this test overrides EVERY logical secret to an absent throwaway container, then
 * populates only the ones under test — hydrate never touches a production container.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { GsmSecretStore } from '../../secrets/gsm-store.js';
import { hydrateFromStore } from '../../secrets/hydrate.js';
import { GSM_CONTAINER_DEFAULTS, type LogicalSecret } from '../../secrets/types.js';

const PROJECT = process.env.GSM_TEST_PROJECT;
const RUN = `shipit-itest-${process.pid}-${Math.floor(performance.now())}`;

const overrideEnvFor = (name: LogicalSecret): string =>
  `SHIPIT_GSM_SECRET_${name.toUpperCase().replace(/-/g, '_')}`;

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nline1\nline2\n-----END RSA PRIVATE KEY-----\n';

describe.skipIf(!PROJECT)('hydrateFromStore — real GCP Secret Manager integration', () => {
  // Constructed in beforeAll (not the describe body) so a skipped run never
  // builds the client — see the note in gsm-store.integration.test.ts.
  let admin: SecretManagerServiceClient;
  const parent = `projects/${PROJECT}`;
  const created: string[] = [];
  const tempDirs: string[] = [];
  let counter = 0;

  async function makeContainer(data: Buffer): Promise<string> {
    const secretId = `${RUN}-${counter++}`;
    await admin.createSecret({ parent, secretId, secret: { replication: { automatic: {} } } });
    created.push(secretId);
    await admin.addSecretVersion({ parent: `${parent}/secrets/${secretId}`, payload: { data } });
    return secretId;
  }

  // Base env: point EVERY logical secret at an absent throwaway container, so an
  // unpopulated read returns null (code 5) instead of hitting a prod container.
  function neutralizedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of Object.keys(GSM_CONTAINER_DEFAULTS) as LogicalSecret[]) {
      env[overrideEnvFor(name)] = `${RUN}-absent-${name}`;
    }
    return env;
  }

  function keyDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'shipit-itest-keys-'));
    tempDirs.push(dir);
    return dir;
  }

  beforeAll(() => {
    admin = new SecretManagerServiceClient();
  });

  afterAll(async () => {
    for (const secretId of created) {
      await admin.deleteSecret({ name: `${parent}/secrets/${secretId}` }).catch(() => undefined);
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('hydrates an unset env var from GSM and materializes the PEM to disk (exact bytes, 0o600)', async () => {
    const idContainer = await makeContainer(Buffer.from('424242', 'utf-8'));
    const pemContainer = await makeContainer(Buffer.from(PEM, 'utf-8'));

    const env = neutralizedEnv();
    env[overrideEnvFor('github-app-id')] = idContainer;
    env[overrideEnvFor('github-app-private-key')] = pemContainer;
    env.SHIPIT_GITHUB_APP_KEY_DIR = keyDir();

    const store = new GsmSecretStore({ projectId: PROJECT!, env });
    const result = await hydrateFromStore(store, env);

    expect(env.GITHUB_APP_ID).toBe('424242');
    expect(result.hydrated).toContain('github-app-id');
    expect(result.hydrated).toContain('github-app-private-key');

    // PEM filename carries the app id; bytes are exact; mode is 0600.
    expect(result.pemPath).toBe(join(env.SHIPIT_GITHUB_APP_KEY_DIR!, 'github-app-424242.pem'));
    expect(readFileSync(result.pemPath!, 'utf-8')).toBe(PEM);
    expect(statSync(result.pemPath!).mode & 0o777).toBe(0o600);
    expect(env.GITHUB_APP_PRIVATE_KEY_PATH).toBe(result.pemPath);
  });

  it('does NOT clobber a pre-set env var (operator override wins)', async () => {
    const idContainer = await makeContainer(Buffer.from('from-gsm', 'utf-8'));

    const env = neutralizedEnv();
    env[overrideEnvFor('github-app-id')] = idContainer;
    env.GITHUB_APP_ID = 'preset-by-operator';

    const store = new GsmSecretStore({ projectId: PROJECT!, env });
    const result = await hydrateFromStore(store, env);

    // Value WAS read (so it's reported hydrated) but the pre-set env wins.
    expect(result.hydrated).toContain('github-app-id');
    expect(env.GITHUB_APP_ID).toBe('preset-by-operator');
  });

  it('treats an empty-string env var as unset and fills it from GSM', async () => {
    const idContainer = await makeContainer(Buffer.from('filled-from-gsm', 'utf-8'));

    const env = neutralizedEnv();
    env[overrideEnvFor('github-app-id')] = idContainer;
    env.GITHUB_APP_ID = ''; // chart ConfigMap placeholder — falsy, must be filled

    const store = new GsmSecretStore({ projectId: PROJECT!, env });
    await hydrateFromStore(store, env);

    expect(env.GITHUB_APP_ID).toBe('filled-from-gsm');
  });
});
