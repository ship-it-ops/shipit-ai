import { describe, it, expect } from 'vitest';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import { requireKnowledge } from '../../routes/knowledge.js';
import type {
  KnowledgeStatus,
  KnowledgeStatusService,
} from '../../services/knowledge/knowledge-status-service.js';

// Same shape as routes/ai.test.ts: a test server from makeTestConfig() and
// server.inject(); the test principal is signed in by default.

const unavailable: KnowledgeStatus = {
  available: false,
  ingestionAvailable: false,
  checks: [
    {
      name: 'database',
      ok: false,
      detail: 'No database is configured (ai.database.url is empty).',
    },
  ],
};

describe('GET /api/knowledge/status', () => {
  it('reports "not set up" on a server built without the service', async () => {
    const server = await createServer({ config: makeTestConfig() });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/knowledge/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: false, ingestionAvailable: false });
    expect(res.json().checks[0].detail).toMatch(/not set up/);
    await server.close();
  });

  it('returns the wired status service result as is', async () => {
    const knowledgeStatus = {
      status: async () => unavailable,
    } as unknown as KnowledgeStatusService;
    const server = await createServer({ config: makeTestConfig(), knowledgeStatus });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/knowledge/status' });
    expect(res.json()).toEqual(unavailable);
    await server.close();
  });
});

describe('requireKnowledge', () => {
  function reply() {
    const sent: { status?: number; body?: unknown } = {};
    const r = {
      status(code: number) {
        sent.status = code;
        return r;
      },
      send(body: unknown) {
        sent.body = body;
        return r;
      },
    };
    return { r, sent };
  }

  it('answers 503 KNOWLEDGE_UNAVAILABLE with the failing checks', async () => {
    const gate = requireKnowledge({
      knowledgeStatus: { status: async () => unavailable } as unknown as KnowledgeStatusService,
    });
    const { r, sent } = reply();
    await gate({} as never, r as never);
    expect(sent.status).toBe(503);
    expect(sent.body).toEqual({
      error: {
        code: 'KNOWLEDGE_UNAVAILABLE',
        message: 'The knowledge layer is not available on this server.',
      },
      checks: unavailable.checks,
    });
  });

  it('lets the request through when ingestion is available', async () => {
    const ok: KnowledgeStatus = { available: false, ingestionAvailable: true, checks: [] };
    const gate = requireKnowledge({
      knowledgeStatus: { status: async () => ok } as unknown as KnowledgeStatusService,
    });
    const { r, sent } = reply();
    expect(await gate({} as never, r as never)).toBeUndefined();
    expect(sent.status).toBeUndefined();
  });

  it('refuses on a server with no service', async () => {
    const { r, sent } = reply();
    await requireKnowledge({})({} as never, r as never);
    expect(sent.status).toBe(503);
  });
});
