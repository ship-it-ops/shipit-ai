import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RequestContext } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';

// The preHandler is exercised transitively by every route test, but those
// tests don't assert the *shape* of `request.ctx` — they just trust it's
// there. These tests pin the shape so a regression that returns undefined
// from the getter, or fails to overwrite the slot in the hook, surfaces as
// a focused failure rather than a confusing "ctx is undefined" deep inside
// a route handler.

function withProbeRoute(server: FastifyInstance, capture: { ctx?: RequestContext }): void {
  server.get('/_probe/ctx', async (request) => {
    capture.ctx = request.ctx;
    return { ok: true };
  });
}

describe('build-context preHandler', () => {
  describe('with auth disabled and no devUser in config', () => {
    let server: FastifyInstance;
    const captured: { ctx?: RequestContext } = {};

    beforeAll(async () => {
      server = await createServer({ config: makeTestConfig() });
      withProbeRoute(server, captured);
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
    });

    it('synthesizes the dev-fallback principal with wildcard capabilities', async () => {
      await server.inject({ method: 'GET', url: '/_probe/ctx' });
      expect(captured.ctx).toBeDefined();
      expect(captured.ctx?.user.provider).toBe('dev-fallback');
      expect(captured.ctx?.user.email).toBe('dev@shipit.local');
      expect(captured.ctx?.user.role).toBe('admin');
      expect(captured.ctx?.user.capabilities).toEqual(['*']);
      expect(captured.ctx?.org).toBe('default');
      expect(captured.ctx?.capabilities.has('*')).toBe(true);
    });
  });

  describe('with auth disabled and a devUser in config', () => {
    let server: FastifyInstance;
    const captured: { ctx?: RequestContext } = {};

    beforeAll(async () => {
      const config = makeTestConfig({
        frontend: {
          api: { url: 'http://localhost:3001' },
          devUser: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            role: 'Engineer',
            team: 'platform',
            joinedAt: '2026-01-01',
            capabilities: ['graph:read', 'graph:write'],
          },
          integrations: {
            pagerduty: { subdomain: null },
            datadog: { site: null },
            github: { org: null },
            slack: { workspace: null, channelPrefix: 'team-' },
            kubernetes: { consoleUrlTemplate: null },
          },
        },
      });
      server = await createServer({ config });
      withProbeRoute(server, captured);
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
    });

    it('mirrors the configured devUser identity and capabilities into the ctx', async () => {
      await server.inject({ method: 'GET', url: '/_probe/ctx' });
      expect(captured.ctx?.user.email).toBe('ada@example.com');
      expect(captured.ctx?.user.displayName).toBe('Ada Lovelace');
      expect(captured.ctx?.user.capabilities).toEqual(['graph:read', 'graph:write']);
      expect(captured.ctx?.capabilities.has('graph:write')).toBe(true);
      // Without the wildcard, ungranted capabilities stay closed.
      expect(captured.ctx?.capabilities.has('connectors:manage')).toBe(false);
    });
  });
});
