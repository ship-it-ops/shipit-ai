import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigExportService } from '../../services/config-export-service.js';

const BASE = `
backend:
  api:
    port: 3001
connectors:
  github:
    app:
      id: "\${GITHUB_APP_ID:-}"
      webhookSecret: ""
`;

const LOCAL = `
backend:
  mcp:
    apiKeySecret: "mcp-key-never-survives"
connectors:
  github:
    app:
      privateKeyPath: /data/keys/github-app-777.pem
      webhookSecret: "should-never-survive"
  instances:
    - id: gh-acme
      type: github
      name: Acme
      installationId: "123"
      org: acme
      lastRuns:
        - startedAt: "2026-06-09T00:00:00Z"
          durationMs: 100
          status: success
          entitiesSynced: 5
`;

describe('ConfigExportService', () => {
  let tmpDir: string;
  let svc: ConfigExportService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-export-'));
    writeFileSync(join(tmpDir, 'shipit.config.yaml'), BASE, 'utf-8');
    writeFileSync(join(tmpDir, 'shipit.config.local.yaml'), LOCAL, 'utf-8');
    svc = new ConfigExportService({
      basePath: join(tmpDir, 'shipit.config.yaml'),
      localPath: join(tmpDir, 'shipit.config.local.yaml'),
    });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('merges base + local, preserving ${ENV} placeholders unsubstituted', () => {
    const out = svc.buildExport();
    const parsed = parseYaml(out);
    expect(parsed.connectors.github.app.id).toBe('${GITHUB_APP_ID:-}');
    expect(parsed.connectors.github.app.privateKeyPath).toBe('/data/keys/github-app-777.pem');
    expect(parsed.backend.api.port).toBe(3001);
  });

  it('scrubs webhookSecret, mcp apiKeySecret, and per-connector lastRuns', () => {
    const out = svc.buildExport();
    expect(out).not.toContain('should-never-survive');
    expect(out).not.toContain('mcp-key-never-survives');
    const parsed = parseYaml(out);
    expect(parsed.connectors.github.app.webhookSecret).toBeUndefined();
    expect(parsed.backend.mcp.apiKeySecret).toBeUndefined();
    // Only the secret key is deleted — sibling keys under backend stay.
    expect(parsed.backend.api.port).toBe(3001);
    expect(parsed.connectors.instances[0].lastRuns).toBeUndefined();
    expect(parsed.connectors.instances[0].id).toBe('gh-acme');
  });

  it('prepends a provenance header comment', () => {
    expect(svc.buildExport()).toMatch(/^# Exported from a running ShipIt-AI instance/);
  });

  it('works when no local file exists (fresh instance)', () => {
    rmSync(join(tmpDir, 'shipit.config.local.yaml'));
    const parsed = parseYaml(svc.buildExport());
    expect(parsed.backend.api.port).toBe(3001);
  });
});
