import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import { makeTestConfig } from './test-config.js';

// Local dev serves the web UI on :3000 and the API on :3001, so every call is
// cross-origin and a browser asks first (a preflight) for anything but a
// plain GET or POST. @fastify/cors allows only GET, HEAD and POST unless
// told otherwise, which refuses every save (PUT), edit (PATCH) and delete.
describe('CORS preflight', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer({ config: makeTestConfig() });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('allows %s from the web UI’s origin', async (method) => {
    const res = await server.inject({
      method: 'OPTIONS',
      url: '/api/agents/3f0e4c1a-0000-4000-8000-000000000000',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': method,
        'access-control-request-headers': 'content-type,if-match',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(String(res.headers['access-control-allow-methods']).split(/,\s*/)).toContain(method);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  // The agent editor reads the revision it must send back as If-Match.
  it('lets the browser read the ETag of a cross-origin response', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(String(res.headers['access-control-expose-headers'])).toContain('ETag');
  });
});
