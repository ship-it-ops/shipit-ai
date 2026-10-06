import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { hashSecret } from '@shipit-ai/shared';
import { createHttpRequestListener } from '../index.js';
import type { McpServerConfig } from '../config.js';
import { createMockNeo4jClient, createMockRecord } from './helpers/mock-neo4j.js';

// The network surface end to end: a real HTTP server, the SDK's transport,
// and the tools, with only the graph stood in for. Every request carries a
// token the server validates against the (stood-in) token store.
const CONFIG = {
  rateLimits: { graphQueryPerDay: 100, rowLimit: 100, hopLimit: 6, queryTimeoutMs: 10_000 },
} as McpServerConfig;

const TOKENS: Record<string, { secret: string; scopes: string[] }> = {
  plain: { secret: 'secret-one', scopes: ['mcp:invoke'] },
  raw: { secret: 'secret-two', scopes: ['mcp:invoke', 'graph:query'] },
};

function tokenStore() {
  const neo4j = createMockNeo4jClient();
  neo4j.runCypher.mockImplementation(async (query: string, params?: Record<string, unknown>) => {
    if (query.includes('_AccessToken')) {
      const row = TOKENS[String(params?.id)];
      if (!row) return { records: [], summary: { resultAvailableAfter: 0 } };
      const properties = {
        id: params?.id,
        tokenHash: hashSecret(row.secret, 'salt'),
        salt: 'salt',
        ownerEmail: `${String(params?.id)}@example.com`,
        scopes: row.scopes,
        revoked: false,
      };
      return {
        records: [createMockRecord({ t: { properties } })],
        summary: { resultAvailableAfter: 0 },
      };
    }
    return { records: [], summary: { resultAvailableAfter: 0 } };
  });
  neo4j.runReadOnlyQuery.mockResolvedValue({
    columns: ['name'],
    rows: [{ name: 'api' }],
    truncated: false,
    withheld: 0,
  });
  return neo4j;
}

describe('the MCP server over HTTP', () => {
  let server: Server;
  let url: string;
  const neo4j = tokenStore();

  beforeAll(async () => {
    server = createServer(createHttpRequestListener(neo4j, CONFIG));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const call = async (who: string | null, tool: string, args: Record<string, unknown> = {}) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (who) headers.authorization = `Bearer shipit_pat_${who}.${TOKENS[who]?.secret ?? 'wrong'}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: { compact: true, ...args } },
      }),
    });
    const text = await response.text();
    // The transport answers over server-sent events: the result is the JSON
    // after "data:"; the tool's payload is the text of its first content block.
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice('data:'.length);
    const message = data
      ? (JSON.parse(data) as { result?: { content: Array<{ text: string }> } })
      : undefined;
    const payload = message?.result
      ? (JSON.parse(message.result.content[0]!.text) as unknown)
      : undefined;
    return {
      status: response.status,
      text,
      payload: payload as Record<string, unknown> | undefined,
    };
  };

  it('answers every request, not only the first', async () => {
    for (let i = 0; i < 3; i++) {
      const { status, payload } = await call('plain', 'graph_stats');
      expect(status).toBe(200);
      expect(payload).toBeDefined();
    }
  });

  it('refuses a request without a token', async () => {
    const { status, text } = await call(null, 'graph_stats');
    expect(status).toBe(401);
    expect(text).toContain('MISSING_TOKEN');
  });

  it('hands graph_query the token, which decides by its scopes', async () => {
    const refused = await call('plain', 'graph_query', { query: 'MATCH (n) RETURN n' });
    expect(refused.status).toBe(200);
    expect((refused.payload as { error?: { code: string } }).error?.code).toBe('RBAC_DENIED');
    expect(neo4j.runReadOnlyQuery).not.toHaveBeenCalled();

    const ran = await call('raw', 'graph_query', { query: 'MATCH (n) RETURN n' });
    expect(ran.status).toBe(200);
    expect(ran.payload).toEqual({ rows: [{ name: 'api' }], row_count: 1 });
    expect(neo4j.runReadOnlyQuery).toHaveBeenCalledTimes(1);
  });
});
