import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config, GitHubConnectorConfig } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { ConnectorRegistry } from '../../services/connector-registry.js';
import { InMemoryConnectorRunStore } from '../../services/connector-run-store.js';
import type { WebhookRefetchPort } from '../../routes/webhooks.js';
import { makeTestConfig } from '../test-config.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const APP_ID = '12345';
const INSTALLATION_ID = '99887766';
const PER_APP_SECRET = 'super-secret-per-app-value';
const GLOBAL_SECRET = 'global-shared-secret-value';

// A minimal GitHub connector config. Only the fields the receiver path touches
// matter (id, type, enabled, installationId, org, app).
function makeConnector(overrides: Partial<GitHubConnectorConfig> = {}): GitHubConnectorConfig {
  return {
    id: 'conn-acme',
    type: 'github',
    enabled: true,
    name: 'Acme',
    installationId: INSTALLATION_ID,
    org: 'acme',
    app: {},
    schedule: '*/15 * * * *',
    scope: {
      repos: { include: ['**'], exclude: [] },
      teams: { include: ['**'], exclude: [] },
      cappedAt: 100,
      cappedAcknowledged: false,
    },
    entities: { repositories: true, teams: true, pipelines: true, codeowners: true },
    lastRuns: [],
    ...overrides,
  } as GitHubConnectorConfig;
}

// Real registry seeded with the given connectors. The receiver only calls
// list(), but other plugins on the server (connectors route) call
// getRunStore() at load time, so a genuine registry is simpler than a stub.
function fakeRegistry(connectors: GitHubConnectorConfig[]): ConnectorRegistry {
  return new ConnectorRegistry({
    localConfigPath: join(keyDir, `connectors-${Math.random().toString(36).slice(2)}.yaml`),
    initial: connectors,
    runStore: new InMemoryConnectorRunStore(),
  });
}

// Fake refetch port: Map-backed dedup, enqueue spy.
function fakeRefetch() {
  const seen = new Set<string>();
  const enqueue = vi.fn(async () => {});
  return {
    enqueue,
    seen,
    markDeliverySeen: vi.fn(async (id: string) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  } satisfies WebhookRefetchPort & {
    seen: Set<string>;
    enqueue: ReturnType<typeof vi.fn>;
    markDeliverySeen: ReturnType<typeof vi.fn>;
  };
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

function pushPayload(): string {
  return JSON.stringify({
    installation: { id: Number(INSTALLATION_ID) },
    repository: {
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
    },
    ref: 'refs/heads/main',
  });
}

function workflowRunPayload(): string {
  return JSON.stringify({
    installation: { id: Number(INSTALLATION_ID) },
    repository: { name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } },
    action: 'completed',
  });
}

function pingPayload(): string {
  return JSON.stringify({ installation: { id: Number(INSTALLATION_ID) }, zen: 'Keep it simple.' });
}

interface InjectOpts {
  event: string;
  delivery: string;
  signature?: string;
  body: string;
}

async function inject(server: FastifyInstance, opts: InjectOpts) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': opts.event,
    'x-github-delivery': opts.delivery,
  };
  if (opts.signature !== undefined) headers['x-hub-signature-256'] = opts.signature;
  return server.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers,
    payload: opts.body,
  });
}

// ── harness ──────────────────────────────────────────────────────────────

let keyDir: string;
const ORIGINAL_KEY_DIR = process.env.SHIPIT_GITHUB_APP_KEY_DIR;
const ORIGINAL_GLOBAL_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

// Per-App connector config: app id set so resolveAppCredentials returns it and
// the sidecar secret is used.
function perAppConfig(): Config {
  const config = makeTestConfig();
  config.connectors.github.app.id = APP_ID;
  return config;
}

function writeSidecar(secret: string) {
  writeFileSync(join(keyDir, `github-app-${APP_ID}.webhook-secret`), `${secret}\n`, 'utf8');
}

beforeAll(() => {
  keyDir = mkdtempSync(join(tmpdir(), 'shipit-webhook-keys-'));
  process.env.SHIPIT_GITHUB_APP_KEY_DIR = keyDir;
});

afterAll(() => {
  if (ORIGINAL_KEY_DIR === undefined) delete process.env.SHIPIT_GITHUB_APP_KEY_DIR;
  else process.env.SHIPIT_GITHUB_APP_KEY_DIR = ORIGINAL_KEY_DIR;
  rmSync(keyDir, { recursive: true, force: true });
});

describe('POST /api/webhooks/github — verify → dedup → enqueue', () => {
  let server: FastifyInstance;
  let refetch: ReturnType<typeof fakeRefetch>;

  beforeEach(async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    writeSidecar(PER_APP_SECRET);
    refetch = fakeRefetch();
    server = await createServer({
      config: perAppConfig(),
      connectorRegistry: fakeRegistry([makeConnector()]),
      webhookRefetch: refetch,
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    if (ORIGINAL_GLOBAL_SECRET === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = ORIGINAL_GLOBAL_SECRET;
  });

  it('valid push → 202 and enqueues a repo refetch with the right owner/repo', async () => {
    const body = pushPayload();
    const res = await inject(server, {
      event: 'push',
      delivery: 'd-push-1',
      signature: sign(body, PER_APP_SECRET),
      body,
    });
    expect(res.statusCode).toBe(202);
    expect(refetch.enqueue).toHaveBeenCalledTimes(1);
    expect(refetch.enqueue).toHaveBeenCalledWith({
      connectorId: 'conn-acme',
      owner: 'acme',
      repo: 'widgets',
      kind: 'repo',
    });
  });

  it('valid workflow_run → 202 and enqueues a workflows refetch', async () => {
    const body = workflowRunPayload();
    const res = await inject(server, {
      event: 'workflow_run',
      delivery: 'd-wf-1',
      signature: sign(body, PER_APP_SECRET),
      body,
    });
    expect(res.statusCode).toBe(202);
    expect(refetch.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workflows', owner: 'acme', repo: 'widgets' }),
    );
  });

  it('bad signature → 401 and does NOT enqueue', async () => {
    const body = pushPayload();
    const res = await inject(server, {
      event: 'push',
      delivery: 'd-bad-1',
      signature: sign(body, 'the-wrong-secret'),
      body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('BAD_SIGNATURE');
    expect(refetch.enqueue).not.toHaveBeenCalled();
  });

  it('missing x-hub-signature-256 → 400 and does NOT enqueue', async () => {
    const body = pushPayload();
    const res = await inject(server, { event: 'push', delivery: 'd-nosig', body });
    expect(res.statusCode).toBe(400);
    expect(refetch.enqueue).not.toHaveBeenCalled();
  });

  it('valid ping → 200', async () => {
    const body = pingPayload();
    const res = await inject(server, {
      event: 'ping',
      delivery: 'd-ping-1',
      signature: sign(body, PER_APP_SECRET),
      body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(refetch.enqueue).not.toHaveBeenCalled();
  });

  it('ping with bad signature → 401 (verification gates even ping)', async () => {
    const body = pingPayload();
    const res = await inject(server, {
      event: 'ping',
      delivery: 'd-ping-bad',
      signature: sign(body, 'nope'),
      body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('pull_request → verified + 202, no enqueue (Cut A scope)', async () => {
    const body = JSON.stringify({
      installation: { id: Number(INSTALLATION_ID) },
      repository: { name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } },
      action: 'opened',
    });
    const res = await inject(server, {
      event: 'pull_request',
      delivery: 'd-pr-1',
      signature: sign(body, PER_APP_SECRET),
      body,
    });
    expect(res.statusCode).toBe(202);
    expect(refetch.enqueue).not.toHaveBeenCalled();
  });

  it('redelivery of the same x-github-delivery → first enqueues, second is deduped', async () => {
    const body = pushPayload();
    const signature = sign(body, PER_APP_SECRET);
    const first = await inject(server, { event: 'push', delivery: 'dup-1', signature, body });
    expect(first.statusCode).toBe(202);
    expect(refetch.enqueue).toHaveBeenCalledTimes(1);

    const second = await inject(server, { event: 'push', delivery: 'dup-1', signature, body });
    expect(second.statusCode).toBe(202);
    expect(second.json().ignored).toBe('duplicate_delivery');
    // Dedup happens BEFORE refetch — still exactly one enqueue.
    expect(refetch.enqueue).toHaveBeenCalledTimes(1);
  });

  it('disabled connector → verified + 202, no enqueue', async () => {
    await server.close();
    server = await createServer({
      config: perAppConfig(),
      connectorRegistry: fakeRegistry([makeConnector({ enabled: false })]),
      webhookRefetch: refetch,
    });
    await server.ready();

    const body = pushPayload();
    const res = await inject(server, {
      event: 'push',
      delivery: 'd-disabled',
      signature: sign(body, PER_APP_SECRET),
      body,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().ignored).toBe('connector_disabled');
    expect(refetch.enqueue).not.toHaveBeenCalled();
  });

  it('enqueue rejection (post-verify throw) → 5xx, not 2xx, not 429', async () => {
    refetch.enqueue.mockRejectedValueOnce(new Error('redis down'));
    const body = pushPayload();
    const res = await inject(server, {
      event: 'push',
      delivery: 'd-throw',
      signature: sign(body, PER_APP_SECRET),
      body,
    });
    expect(res.statusCode).toBe(500);
    expect(res.statusCode).not.toBe(429);
    expect(res.json().error.code).toBe('WEBHOOK_PROCESSING_FAILED');
  });

  it('does not 429 a verified burst (rate limiting disabled on the route)', async () => {
    const body = pingPayload();
    const signature = sign(body, PER_APP_SECRET);
    for (let i = 0; i < 250; i++) {
      const res = await inject(server, { event: 'ping', delivery: `burst-${i}`, signature, body });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('POST /api/webhooks/github — secret downgrade guard (INV-3)', () => {
  let refetch: ReturnType<typeof fakeRefetch>;

  beforeEach(() => {
    refetch = fakeRefetch();
  });

  afterEach(() => {
    if (ORIGINAL_GLOBAL_SECRET === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = ORIGINAL_GLOBAL_SECRET;
  });

  it('unknown installation id → 202, no enqueue, no global-secret verification', async () => {
    // A global secret IS present and the forged body is signed WITH it — if the
    // handler wrongly fell back to the global secret it would verify + enqueue.
    process.env.GITHUB_WEBHOOK_SECRET = GLOBAL_SECRET;
    writeSidecar(PER_APP_SECRET);
    const server = await createServer({
      config: perAppConfig(),
      connectorRegistry: fakeRegistry([makeConnector()]),
      webhookRefetch: refetch,
    });
    await server.ready();
    try {
      const body = JSON.stringify({
        installation: { id: 11112222 }, // not in the registry
        repository: { name: 'widgets', full_name: 'evil/widgets', owner: { login: 'evil' } },
      });
      const res = await inject(server, {
        event: 'push',
        delivery: 'd-unknown',
        signature: sign(body, GLOBAL_SECRET),
        body,
      });
      expect(res.statusCode).toBe(202);
      // Opaque body — must NOT reveal that this installation is unknown (vs a
      // known connector lacking a secret), or an unauthenticated caller could
      // enumerate configured installations (SC4).
      expect(res.json()).toEqual({ ok: true });
      expect(refetch.enqueue).not.toHaveBeenCalled();
      expect(refetch.markDeliverySeen).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('per-org connector (app override) with NO sidecar + global secret present → forged delivery is never accepted under the global secret', async () => {
    // The connector OVERRIDES the App (per-org id) and has NO sidecar secret.
    // resolveWebhookSecret must return source:'none' (no downgrade), so even a
    // delivery correctly signed with the global secret fails verification.
    const PER_ORG_APP_ID = '55554444';
    process.env.GITHUB_WEBHOOK_SECRET = GLOBAL_SECRET;
    // Ensure NO sidecar exists for the per-org app id.
    rmSync(join(keyDir, `github-app-${PER_ORG_APP_ID}.webhook-secret`), { force: true });

    const config = makeTestConfig();
    // No global app id — the connector's own override is the only app identity.
    const connector = makeConnector({
      app: { id: PER_ORG_APP_ID } as GitHubConnectorConfig['app'],
    });
    const server = await createServer({
      config,
      connectorRegistry: fakeRegistry([connector]),
      webhookRefetch: refetch,
    });
    await server.ready();
    try {
      const body = pushPayload();
      const res = await inject(server, {
        event: 'push',
        delivery: 'd-forged-global',
        signature: sign(body, GLOBAL_SECRET),
        body,
      });
      // 202 (no resolvable secret) — never verified under the global secret.
      expect([202, 401]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(200);
      expect(refetch.enqueue).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe('POST /api/webhooks/github — duplicate-key JSON cannot diverge selector vs dispatch', () => {
  afterEach(() => {
    if (ORIGINAL_GLOBAL_SECRET === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = ORIGINAL_GLOBAL_SECRET;
  });

  it('a body with a duplicate installation.id key verifies, then routes consistently', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    writeSidecar(PER_APP_SECRET);
    const refetch = fakeRefetch();
    const server = await createServer({
      config: perAppConfig(),
      connectorRegistry: fakeRegistry([makeConnector()]),
      webhookRefetch: refetch,
    });
    await server.ready();
    try {
      // Two installation objects; JSON.parse keeps the LAST. The selector parse
      // and the verified re-parse use the SAME bytes + SAME parser, so they can
      // never diverge — and the secret resolves to the matched connector.
      const body =
        `{"installation":{"id":11112222},` +
        `"installation":{"id":${INSTALLATION_ID}},` +
        `"repository":{"name":"widgets","full_name":"acme/widgets","owner":{"login":"acme"}}}`;
      const res = await inject(server, {
        event: 'push',
        delivery: 'd-dupkey',
        signature: sign(body, PER_APP_SECRET),
        body,
      });
      // Last-wins id (INSTALLATION_ID) is in the registry → verified + enqueued.
      expect(res.statusCode).toBe(202);
      expect(refetch.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 'conn-acme' }),
      );
    } finally {
      await server.close();
    }
  });
});

describe('POST /api/webhooks/github — reachable in setup mode', () => {
  it('setup-mode server still serves the receiver (not 401 SETUP_MODE) and 202s', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    writeSidecar(PER_APP_SECRET);
    const config = perAppConfig();
    config.accessControl.auth.enabled = true;
    const refetch = fakeRefetch();
    const server = await createServer({
      config,
      setupMode: true,
      connectorRegistry: fakeRegistry([makeConnector()]),
      webhookRefetch: refetch,
    });
    await server.ready();
    try {
      const body = pingPayload();
      const res = await inject(server, {
        event: 'ping',
        delivery: 'd-setup',
        signature: sign(body, PER_APP_SECRET),
        body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });
});
