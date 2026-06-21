/**
 * REAL-GCP integration test for GsmSecretStore (#5, integration-test roadmap).
 *
 * The unit suite (gsm-store.test.ts) injects a mock client and INVENTS the gRPC
 * error codes — `Object.assign(new Error(), { code: 5 })`. So the contract that
 * actually matters at boot is unverified: does the real @google-cloud/secret-manager
 * client return code 5 (NOT_FOUND) for a versionless / absent container — the value
 * the store maps to "first-run, hydrate nothing"? And does a real version round-trip
 * a multiline PEM byte-for-byte? This runs the store's real getClient() →
 * accessSecretVersion()/addSecretVersion() path against a real GCP project.
 *
 * Gated on GSM_TEST_PROJECT (skips by default → unit `pnpm test` stays creds-free).
 * Needs Application Default Credentials (`gcloud auth application-default login`)
 * with create/add/delete on Secret Manager in that project. NOT CI-enforced: CI has
 * no GCP creds. Run locally with:
 *   GSM_TEST_PROJECT=<project> pnpm --filter @shipit-ai/api-server run test:integration
 *
 * Isolation: every container is named shipit-itest-<pid>-<perf>-<n> and DELETED in
 * afterAll, so it never collides with the Terraform-managed shipit-* containers.
 *
 * NOT covered here (deliberately):
 *  - PERMISSION_DENIED (code 7): can't be exercised with self-owned throwaway secrets —
 *    the identity that creates a container inherently can read it. Stays unit-only
 *    (see gsm-store.test.ts "propagates non-NOT_FOUND errors").
 *  - Empty-payload version → null: real GCM REJECTS a zero-length payload with
 *    `INVALID_ARGUMENT: Secret Payload cannot be empty` (verified 2026-06-20), so the
 *    store's `text.length > 0 ? text : null` branch is unreachable from real GSM —
 *    no version can ever carry an empty value. The branch stays as defensive code;
 *    the unit suite covers it with a synthetic empty payload.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { GsmSecretStore } from '../../secrets/gsm-store.js';
import type { LogicalSecret } from '../../secrets/types.js';

const PROJECT = process.env.GSM_TEST_PROJECT;
const RUN = `shipit-itest-${process.pid}-${Math.floor(performance.now())}`;

// Override-env key the store reads to point a logical secret at a custom
// container — mirrors gsmContainerFor()'s SHIPIT_GSM_SECRET_<UPPER_SNAKE>.
const overrideEnvFor = (name: LogicalSecret): string =>
  `SHIPIT_GSM_SECRET_${name.toUpperCase().replace(/-/g, '_')}`;

describe.skipIf(!PROJECT)('GsmSecretStore — real GCP Secret Manager integration', () => {
  // Constructed in beforeAll (not the describe body) so a skipped run — which
  // still executes this callback at collection time — never builds the client.
  let admin: SecretManagerServiceClient;
  const parent = `projects/${PROJECT}`;
  const created: string[] = [];
  let counter = 0;

  // Create a fresh, empty throwaway container; return its short id.
  async function makeContainer(): Promise<string> {
    const secretId = `${RUN}-${counter++}`;
    await admin.createSecret({
      parent,
      secretId,
      secret: { replication: { automatic: {} } },
    });
    created.push(secretId);
    return secretId;
  }

  async function addVersion(secretId: string, data: Buffer): Promise<void> {
    await admin.addSecretVersion({
      parent: `${parent}/secrets/${secretId}`,
      payload: { data },
    });
  }

  // A store whose logical `name` resolves to throwaway `container`.
  function storeFor(name: LogicalSecret, container: string): GsmSecretStore {
    return new GsmSecretStore({
      projectId: PROJECT!,
      env: { [overrideEnvFor(name)]: container } as NodeJS.ProcessEnv,
    });
  }

  beforeAll(() => {
    admin = new SecretManagerServiceClient();
  });

  afterAll(async () => {
    for (const secretId of created) {
      await admin.deleteSecret({ name: `${parent}/secrets/${secretId}` }).catch(() => undefined); // best-effort cleanup; don't fail the suite on a stray
    }
  });

  it('reads the latest version of a real container (payload decodes utf-8)', async () => {
    const c = await makeContainer();
    await addVersion(c, Buffer.from('hello-secret', 'utf-8'));
    const store = storeFor('github-webhook-secret', c);
    expect(await store.read('github-webhook-secret')).toBe('hello-secret');
  });

  it('reads the LATEST when multiple versions exist', async () => {
    const c = await makeContainer();
    await addVersion(c, Buffer.from('v1', 'utf-8'));
    await addVersion(c, Buffer.from('v2', 'utf-8'));
    const store = storeFor('github-webhook-secret', c);
    expect(await store.read('github-webhook-secret')).toBe('v2');
  });

  it('returns null for a container that has NO version yet (real grpc NOT_FOUND, code 5)', async () => {
    const c = await makeContainer(); // created empty, never add a version
    const store = storeFor('oidc-client-secret', c);
    // This is the contract the unit test can only fake: real GSM answers
    // accessSecretVersion(.../versions/latest) with code 5 here, which the
    // store maps to null ("first run, nothing to hydrate").
    expect(await store.read('oidc-client-secret')).toBeNull();
  });

  it('returns null for a container that does not exist at all (real NOT_FOUND)', async () => {
    const store = storeFor('oidc-client-secret', `${RUN}-absent-never-created`);
    expect(await store.read('oidc-client-secret')).toBeNull();
  });

  it('round-trips a multiline PEM byte-for-byte through the store write→read path', async () => {
    const c = await makeContainer();
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\n';
    // github-app-private-key is in WRITABLE_SECRETS, so store.write (addSecretVersion)
    // is allowed — exercises the real write path, not just the admin client.
    const store = storeFor('github-app-private-key', c);
    await store.write('github-app-private-key', pem);
    expect(await store.read('github-app-private-key')).toBe(pem);
  });
});
