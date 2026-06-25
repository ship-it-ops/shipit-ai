import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { FeedbackService } from '../../services/feedback-service.js';
import { makeTestConfig } from '../test-config.js';

// Auth-disabled server → require-auth synthesizes the dev-fallback admin
// principal (email dev@shipit.local), so the handler runs as a signed-in user.
const DEV_EMAIL = 'dev@shipit.local';

function configWithFeedback(): Config {
  const config = makeTestConfig();
  config.feedback = {
    enabled: true,
    repo: { owner: 'ship-it-ops', name: 'shipit-ai' },
    defaultLabels: ['user-report'],
  };
  return config;
}

interface Harness {
  server: FastifyInstance;
  create: ReturnType<typeof vi.fn>;
}

async function makeHarness(
  opts: { token?: string | undefined; create?: ReturnType<typeof vi.fn> } = {},
): Promise<Harness> {
  const config = configWithFeedback();
  const create =
    opts.create ??
    vi.fn(async () => ({ data: { html_url: 'https://github.com/x/issues/42', number: 42 } }));
  const feedbackService = new FeedbackService({
    feedback: config.feedback,
    env: { FEEDBACK_GITHUB_TOKEN: 'token' in opts ? (opts.token as string) : 'pat-xyz' },
    octokitForToken: async () => ({ rest: { issues: { create } } }) as never,
  });
  const server = await createServer({ config, feedbackService });
  await server.ready();
  return { server, create };
}

const VALID = {
  type: 'bug',
  title: 'Catalog filter crashes',
  description: 'Clicking the Type filter throws.',
  context: {
    url: 'https://portal/catalog',
    route: '/catalog',
    userAgent: 'Firefox',
    viewport: '1440x900',
  },
  logs: [{ level: 'error', message: 'TypeError: x is undefined' }],
};

describe('POST /api/feedback', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it('files an issue and returns the url + number', async () => {
    const res = await h.server.inject({ method: 'POST', url: '/api/feedback', payload: VALID });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issueUrl: 'https://github.com/x/issues/42', issueNumber: 42 });

    const args = h.create.mock.calls[0][0];
    expect(args.labels).toEqual(['user-report', 'bug']);
    expect(args.body).toContain(DEV_EMAIL); // reporter attributed from the session
    expect(args.body).toContain('TypeError: x is undefined');
  });

  it('rejects a missing title → 400', async () => {
    const res = await h.server.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { ...VALID, title: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FEEDBACK');
  });

  it('rejects an invalid type → 400', async () => {
    const res = await h.server.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { ...VALID, type: 'rant' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FEEDBACK');
  });

  it('returns 503 when feedback is not configured (no token)', async () => {
    await h.server.close();
    h = await makeHarness({ token: undefined });
    const res = await h.server.inject({ method: 'POST', url: '/api/feedback', payload: VALID });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('FEEDBACK_DISABLED');
  });

  it('maps an Octokit failure to 502 without leaking the upstream error', async () => {
    await h.server.close();
    const create = vi.fn(async () => {
      throw new Error('403 Resource not accessible by personal access token');
    });
    h = await makeHarness({ create });
    const res = await h.server.inject({ method: 'POST', url: '/api/feedback', payload: VALID });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('ISSUE_CREATE_FAILED');
    expect(res.json().error.message).not.toContain('personal access token');
  });

  it('GET /config reports enabled', async () => {
    const res = await h.server.inject({ method: 'GET', url: '/api/feedback/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
  });
});
