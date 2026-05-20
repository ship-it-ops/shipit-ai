import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';

let dir: string;
let basePath: string;
let localPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipit-config-'));
  basePath = join(dir, 'shipit.config.yaml');
  localPath = join(dir, 'shipit.config.local.yaml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fullBase = `
backend:
  neo4j:
    uri: bolt://localhost:7687
    user: neo4j
    password: pw
  redis:
    url: redis://localhost:6379
  api:
    port: 3001
  schema:
    path: ./config/shipit-schema.yaml
  cypherQuery:
    timeoutMs: 5000
    rowLimit: 1000
  reconciliation:
    threshold: 0.85
  mcp:
    apiKeySecret: null
    rateLimits:
      graphQueryPerDay: 100
      rowLimit: 1000
      hopLimit: 6
      queryTimeoutMs: 10000
frontend:
  api:
    url: http://localhost:3001
  integrations:
    pagerduty: { subdomain: null }
    datadog: { site: null }
    github: { org: null }
    slack: { workspace: null, channelPrefix: team- }
    kubernetes: { consoleUrlTemplate: null }
`;

describe('loadConfig', () => {
  it('loads a valid base file with no local overrides', () => {
    writeFileSync(basePath, fullBase);
    const cfg = loadConfig({ basePath, localPath, env: {} });
    expect(cfg.backend.neo4j.uri).toBe('bolt://localhost:7687');
    expect(cfg.backend.api.port).toBe(3001);
    expect(cfg.frontend.integrations.slack.channelPrefix).toBe('team-');
  });

  it('deep-merges local overrides over base, leaf by leaf', () => {
    writeFileSync(basePath, fullBase);
    writeFileSync(
      localPath,
      `
backend:
  neo4j:
    password: local-pw
frontend:
  devUser:
    firstName: Ada
    lastName: Lovelace
    email: ada@example.com
    role: Engineer
    team: platform
    joinedAt: 2026-01-01
    capabilities: [admin]
`,
    );
    const cfg = loadConfig({ basePath, localPath, env: {} });
    expect(cfg.backend.neo4j.password).toBe('local-pw');
    expect(cfg.backend.neo4j.uri).toBe('bolt://localhost:7687'); // unchanged
    expect(cfg.frontend.devUser?.firstName).toBe('Ada');
  });

  it('substitutes ${ENV_VAR} from the supplied env', () => {
    writeFileSync(basePath, fullBase.replace('password: pw', 'password: ${NEO4J_PASSWORD}'));
    const cfg = loadConfig({ basePath, localPath, env: { NEO4J_PASSWORD: 'secret' } });
    expect(cfg.backend.neo4j.password).toBe('secret');
  });

  it('uses ${VAR:-default} fallback when env var is unset', () => {
    writeFileSync(
      basePath,
      fullBase.replace('uri: bolt://localhost:7687', 'uri: ${NEO4J_URI:-bolt://fallback:7687}'),
    );
    const cfg = loadConfig({ basePath, localPath, env: {} });
    expect(cfg.backend.neo4j.uri).toBe('bolt://fallback:7687');
  });

  it('throws with the dotted path when a required env var is missing', () => {
    writeFileSync(basePath, fullBase.replace('password: pw', 'password: ${NEO4J_PASSWORD}'));
    expect(() => loadConfig({ basePath, localPath, env: {} })).toThrow(
      /backend\.neo4j\.password.*NEO4J_PASSWORD/,
    );
  });

  it('replaces arrays rather than merging them', () => {
    writeFileSync(basePath, fullBase);
    writeFileSync(
      localPath,
      `
frontend:
  devUser:
    firstName: Ada
    lastName: Lovelace
    email: ada@example.com
    role: Engineer
    team: platform
    joinedAt: 2026-01-01
    capabilities: [admin, graph:write]
`,
    );
    const cfg = loadConfig({ basePath, localPath, env: {} });
    expect(cfg.frontend.devUser?.capabilities).toEqual(['admin', 'graph:write']);
  });

  it('throws with a useful message when validation fails', () => {
    writeFileSync(basePath, fullBase.replace('port: 3001', 'port: "three thousand"'));
    expect(() => loadConfig({ basePath, localPath, env: {} })).toThrow(/backend\.api\.port/);
  });

  it('treats a missing local file as no overrides', () => {
    writeFileSync(basePath, fullBase);
    const cfg = loadConfig({ basePath, localPath, env: {} });
    expect(cfg.backend.neo4j.password).toBe('pw');
  });

  it('treats empty string env var the same as unset (falls back to default)', () => {
    writeFileSync(
      basePath,
      fullBase.replace('uri: bolt://localhost:7687', 'uri: ${NEO4J_URI:-bolt://fallback:7687}'),
    );
    const cfg = loadConfig({ basePath, localPath, env: { NEO4J_URI: '' } });
    expect(cfg.backend.neo4j.uri).toBe('bolt://fallback:7687');
  });
});
