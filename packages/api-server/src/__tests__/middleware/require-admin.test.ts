import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from '../../middleware/require-auth.js';

function call(role: 'admin' | 'member') {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  const request = {
    ctx: { user: { id: 'u1', role } },
    url: '/api/connectors/gh-1?x=1',
    log: { warn: () => undefined },
  } as unknown as FastifyRequest;
  return { result: requireAdmin(request, reply), sent };
}

describe('requireAdmin', () => {
  it('lets an admin through', async () => {
    const { result, sent } = call('admin');
    expect(await result).toBeUndefined();
    expect(sent.status).toBeUndefined();
  });

  it('answers 403 FORBIDDEN to a member', async () => {
    const { result, sent } = call('member');
    await result;
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({
      error: { code: 'FORBIDDEN', message: 'This action requires an administrator.' },
    });
  });
});
