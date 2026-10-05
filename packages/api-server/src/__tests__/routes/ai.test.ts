import { describe, it, expect } from 'vitest';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import type { AiStatus, AiStatusService } from '../../services/ai/ai-status-service.js';

describe('ai routes', () => {
  it('reports "not set up" from /api/ai/status when no status service is wired', async () => {
    const server = await createServer({ config: makeTestConfig() });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/ai/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: false, definitionsAvailable: false });
    expect(res.json().checks).toHaveLength(1);
    await server.close();
  });

  it('returns the wired status service result as is', async () => {
    const status: AiStatus = {
      available: true,
      definitionsAvailable: true,
      checks: [{ name: 'enabled', ok: true, detail: 'on' }],
    };
    const server = await createServer({
      config: makeTestConfig(),
      aiStatus: { status: async () => status } as unknown as AiStatusService,
    });
    await server.ready();
    expect((await server.inject({ method: 'GET', url: '/api/ai/status' })).json()).toEqual(status);
    await server.close();
  });

  it('lists the model catalog without the provider model ids', async () => {
    const server = await createServer({ config: makeTestConfig() });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/ai/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      defaultModel: 'claude-opus',
      models: [
        {
          key: 'claude-opus',
          label: 'Claude Opus',
          family: 'anthropic',
          contextWindow: 1_000_000,
          tools: true,
        },
        { key: 'gemini', label: 'Gemini', family: 'gemini', contextWindow: 1_000_000, tools: true },
      ],
    });
    expect(res.body).not.toContain('claude-opus-5-5');
    await server.close();
  });

  it('returns an empty catalog on a server with no config', async () => {
    const server = await createServer();
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/ai/models' });
    expect(res.json()).toEqual({ defaultModel: '', models: [] });
    await server.close();
  });
});
