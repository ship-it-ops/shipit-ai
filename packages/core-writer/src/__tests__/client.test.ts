import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Neo4jClient } from '../neo4j/client.js';

// Captures the options each driver.session() call receives. Newer Aura
// tiers name the database after the instance ID and have NO db named
// `neo4j` — sessions pinned to a literal `neo4j` fail with
// DatabaseNotFound on boot (2026-06-11 deploy blocker).
const sessionMock = vi.fn(() => ({
  executeWrite: vi.fn(),
  executeRead: vi.fn(),
  close: vi.fn(),
}));

vi.mock('neo4j-driver', () => ({
  default: {
    driver: vi.fn(() => ({
      verifyConnectivity: vi.fn().mockResolvedValue(undefined),
      session: sessionMock,
      close: vi.fn(),
    })),
    auth: { basic: vi.fn() },
  },
}));

const CONN = { uri: 'neo4j+s://test', username: 'u', password: 'p' };

describe('Neo4jClient session database selection', () => {
  beforeEach(() => {
    sessionMock.mockClear();
  });

  it('uses the configured database as the session default (Aura instance-ID naming)', async () => {
    const client = new Neo4jClient();
    await client.connect({ ...CONN, database: '8a63b716' });
    client.getSession();
    expect(sessionMock).toHaveBeenCalledWith({ database: '8a63b716' });
  });

  it('falls back to `neo4j` when no database is configured (local default)', async () => {
    const client = new Neo4jClient();
    await client.connect(CONN);
    client.getSession();
    expect(sessionMock).toHaveBeenCalledWith({ database: 'neo4j' });
  });

  it('a per-call database still wins over the configured default', async () => {
    const client = new Neo4jClient();
    await client.connect({ ...CONN, database: '8a63b716' });
    client.getSession('explicit-db');
    expect(sessionMock).toHaveBeenCalledWith({ database: 'explicit-db' });
  });

  it('executeWrite opens its session against the configured database', async () => {
    const client = new Neo4jClient();
    await client.connect({ ...CONN, database: '8a63b716' });
    await client.executeWrite(async () => 'ok');
    expect(sessionMock).toHaveBeenCalledWith({ database: '8a63b716' });
  });
});
