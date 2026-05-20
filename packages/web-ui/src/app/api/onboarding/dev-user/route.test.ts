import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the repo-root helper before importing the route so the handler writes
// into the tmpdir we control instead of the real repo.
const mockPaths = vi.hoisted(() => ({ repoRoot: '', basePath: '', localPath: '' }));
vi.mock('@/lib/onboarding/repo-root', () => ({
  findConfigPaths: () => {
    if (!mockPaths.localPath) throw new Error('repo-root not configured for test');
    return { ...mockPaths };
  },
}));

// Importing after the vi.mock so the mock takes effect.
import { POST } from './route';

const EXAMPLE_YAML = `backend:
  neo4j:
    password: shipit-dev
frontend:
  devUser:
    # Mock identity until real auth lands.
    firstName: Dev
    lastName: User
    email: dev@shipit.local
    role: Platform Admin
    team: platform-team
    joinedAt: 2026-01-01
    capabilities:
      - admin
`;

const validPayload = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  role: 'Platform Admin',
  team: 'platform-team',
  joinedAt: '2026-05-19',
  capabilities: ['admin', 'graph:write'],
};

let tmp: string;
const originalEnv = process.env.NODE_ENV;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shipit-onboarding-test-'));
  const localPath = join(tmp, 'shipit.config.local.yaml');
  writeFileSync(localPath, EXAMPLE_YAML, 'utf-8');
  mockPaths.repoRoot = tmp;
  mockPaths.basePath = join(tmp, 'shipit.config.yaml');
  mockPaths.localPath = localPath;
  (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
});

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/onboarding/dev-user', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/onboarding/dev-user', () => {
  it('writes the new devUser values into the local YAML', async () => {
    const res = await POST(makeReq(validPayload));
    expect(res.status).toBe(200);

    const written = readFileSync(mockPaths.localPath, 'utf-8');
    expect(written).toContain('firstName: Ada');
    expect(written).toContain('lastName: Lovelace');
    expect(written).toContain('email: ada@example.com');
    expect(written).toContain('joinedAt: 2026-05-19');
    expect(written).toContain('- admin');
    expect(written).toContain('- graph:write');
  });

  it('preserves comments from the existing YAML', async () => {
    const res = await POST(makeReq(validPayload));
    expect(res.status).toBe(200);

    const written = readFileSync(mockPaths.localPath, 'utf-8');
    expect(written).toContain('# Mock identity until real auth lands.');
  });

  it('returns 400 on validation errors', async () => {
    const res = await POST(makeReq({ ...validPayload, email: 'not-an-email' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('validation');
  });

  it('returns 403 in production', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const res = await POST(makeReq(validPayload));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('production_disabled');
  });

  it('returns 500 with manualYaml when the local file is missing', async () => {
    rmSync(mockPaths.localPath);
    const res = await POST(makeReq(validPayload));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; manualYaml: string };
    expect(body.code).toBe('config_missing');
    expect(body.manualYaml).toContain('firstName: Ada');
    expect(body.manualYaml).toContain('- graph:write');
  });

  it('returns 400 when the body is not JSON', async () => {
    const req = new Request('http://localhost/api/onboarding/dev-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
