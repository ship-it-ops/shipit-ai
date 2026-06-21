import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import { connectorInstanceSchema } from '@shipit-ai/shared';
import { ConnectorAppStore } from '../../services/connector-app-store.js';
import type { LogicalSecret, SecretStore } from '../../secrets/types.js';

// In-memory gsm-shaped store — the blob is just a string read/write over a Map.
function fakeGsmStore(initial: Partial<Record<LogicalSecret, string>> = {}): SecretStore & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    kind: 'gsm',
    values,
    read: async (name) => values.get(name) ?? null,
    write: async (name, value) => {
      values.set(name, value);
    },
  };
}

function perOrgConnector(id: string, appId: string, keyDir: string): ConnectorInstanceConfig {
  return connectorInstanceSchema.parse({
    id,
    type: 'github',
    name: id,
    installationId: '123',
    org: id,
    app: { id: appId, privateKeyPath: join(keyDir, `github-app-${appId}.pem`) },
  });
}

function sharedConnector(id: string): ConnectorInstanceConfig {
  return connectorInstanceSchema.parse({
    id,
    type: 'github',
    name: id,
    installationId: '456',
    org: id,
  });
}

describe('ConnectorAppStore', () => {
  let keyDir: string;

  beforeEach(() => {
    keyDir = mkdtempSync(join(tmpdir(), 'shipit-connector-apps-'));
  });

  afterEach(() => {
    rmSync(keyDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sync writes a blob with the per-org PEM (read from disk) and omits it for shared connectors', async () => {
    const store = fakeGsmStore();
    writeFileSync(join(keyDir, 'github-app-777.pem'), 'PEM-777', { mode: 0o600 });
    writeFileSync(join(keyDir, 'github-app-777.webhook-secret'), 'wh-777\n', { mode: 0o600 });

    const svc = new ConnectorAppStore({ store, keyDir });
    await svc.sync([perOrgConnector('gh-a', '777', keyDir), sharedConnector('gh-b')]);

    const blob = JSON.parse(store.values.get('connector-apps')!) as {
      version: number;
      connectors: Record<
        string,
        { instance: { id: string }; pem?: string; webhookSecret?: string }
      >;
    };
    expect(blob.version).toBe(1);
    expect(blob.connectors['gh-a'].pem).toBe('PEM-777');
    expect(blob.connectors['gh-a'].webhookSecret).toBe('wh-777');
    // Shared connector carries instance config only — no secret.
    expect(blob.connectors['gh-b'].pem).toBeUndefined();
    expect(blob.connectors['gh-b'].instance.id).toBe('gh-b');
    // lastRuns (operational state) is never persisted into the durable blob.
    expect(
      (blob.connectors['gh-a'].instance as unknown as { lastRuns?: unknown }).lastRuns,
    ).toBeUndefined();
  });

  it('loadAndMaterialize rehydrates instances and writes the PEM file (0600)', async () => {
    const store = fakeGsmStore();
    // Seed a blob by syncing, then wipe the on-disk PEM to prove materialize re-creates it.
    writeFileSync(join(keyDir, 'github-app-777.pem'), 'PEM-777', { mode: 0o600 });
    const svc = new ConnectorAppStore({ store, keyDir });
    await svc.sync([perOrgConnector('gh-a', '777', keyDir)]);
    rmSync(join(keyDir, 'github-app-777.pem'));
    expect(existsSync(join(keyDir, 'github-app-777.pem'))).toBe(false);

    const instances = await svc.loadAndMaterialize();
    expect(instances).not.toBeNull();
    expect(instances!.map((c) => c.id)).toEqual(['gh-a']);
    const pemPath = join(keyDir, 'github-app-777.pem');
    expect(readFileSync(pemPath, 'utf-8')).toBe('PEM-777');
    expect(statSync(pemPath).mode & 0o777).toBe(0o600);
  });

  it('loadAndMaterialize returns null when no blob exists yet (first run)', async () => {
    const svc = new ConnectorAppStore({ store: fakeGsmStore(), keyDir });
    expect(await svc.loadAndMaterialize()).toBeNull();
  });

  it('loadAndMaterialize returns [] for a blob with zero connectors (authoritative, no resurrection)', async () => {
    const store = fakeGsmStore({
      'connector-apps': JSON.stringify({ version: 1, connectors: {} }),
    });
    const svc = new ConnectorAppStore({ store, keyDir });
    expect(await svc.loadAndMaterialize()).toEqual([]);
  });

  it('skips malformed connector records instead of crashing', async () => {
    const store = fakeGsmStore({
      'connector-apps': JSON.stringify({
        version: 1,
        connectors: {
          bad: { instance: { id: 'bad', type: 'github' /* missing required fields */ } },
          good: { instance: sharedConnector('good') },
        },
      }),
    });
    const svc = new ConnectorAppStore({ store, keyDir });
    const instances = await svc.loadAndMaterialize();
    expect(instances!.map((c) => c.id)).toEqual(['good']);
  });

  it('is a no-op for a file-kind store (local dev persists on the real fs)', async () => {
    const fileStore: SecretStore = {
      kind: 'file',
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new ConnectorAppStore({ store: fileStore, keyDir });
    await svc.sync([perOrgConnector('gh-a', '777', keyDir)]);
    expect(fileStore.write).not.toHaveBeenCalled();
    expect(await svc.loadAndMaterialize()).toBeNull();
    expect(fileStore.read).not.toHaveBeenCalled();
  });

  it('setWebhookSecret writes the per-App sidecar (0600, trailing newline) and re-syncs the blob', async () => {
    const store = fakeGsmStore();
    const connector = perOrgConnector('gh-a', '777', keyDir);
    // The PEM must exist on disk for sync() to fold the secret into the blob
    // (sync only reads the webhook sidecar when the connector has app.id + PEM).
    writeFileSync(join(keyDir, 'github-app-777.pem'), 'PEM-777', { mode: 0o600 });

    const svc = new ConnectorAppStore({ store, keyDir });
    await svc.setWebhookSecret('777', 'wh-new-secret', [connector]);

    const secretPath = join(keyDir, 'github-app-777.webhook-secret');
    expect(readFileSync(secretPath, 'utf-8')).toBe('wh-new-secret\n');
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);

    const blob = JSON.parse(store.values.get('connector-apps')!) as {
      connectors: Record<string, { webhookSecret?: string }>;
    };
    expect(blob.connectors['gh-a'].webhookSecret).toBe('wh-new-secret');
  });

  it('setWebhookSecret persists the sidecar even in file mode (no blob write)', async () => {
    const fileStore: SecretStore = {
      kind: 'file',
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new ConnectorAppStore({ store: fileStore, keyDir });
    await svc.setWebhookSecret('888', 'wh-file-secret', [perOrgConnector('gh-f', '888', keyDir)]);

    // Sidecar still written on disk (the durable home in file mode)...
    expect(readFileSync(join(keyDir, 'github-app-888.webhook-secret'), 'utf-8')).toBe(
      'wh-file-secret\n',
    );
    // ...but sync() is a no-op for a file-kind store, so no blob write.
    expect(fileStore.write).not.toHaveBeenCalled();
  });

  it('sync swallows a GSM write failure (durability degrades, mutation does not fail)', async () => {
    const store: SecretStore = {
      kind: 'gsm',
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockRejectedValue(new Error('permission denied')),
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const svc = new ConnectorAppStore({ store, keyDir, logger });
    await expect(svc.sync([sharedConnector('gh-a')])).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
