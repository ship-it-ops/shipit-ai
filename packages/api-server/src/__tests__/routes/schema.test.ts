import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../server.js';
import { SchemaService } from '../../services/schema-service.js';
import { DEFAULT_SCHEMA } from '@shipit-ai/shared';
import { stringify as stringifyYaml } from 'yaml';
import type { FastifyInstance } from 'fastify';

const validYaml = stringifyYaml(DEFAULT_SCHEMA);

const invalidYaml = `
version: "1.0"
mode: "invalid_mode"
node_types: {}
relationship_types: {}
`;

describe('Schema routes', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const schemaService = new SchemaService('/tmp/test-schema.yaml');
    // Pre-load with default schema
    (schemaService as unknown as { schema: unknown }).schema = DEFAULT_SCHEMA;

    server = await createServer({ schemaService });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /api/schema returns the current schema', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/schema',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.version).toBe('1.0');
    expect(body.mode).toBe('full');
    expect(body.node_types).toBeDefined();
  });

  it('POST /api/schema/validate with valid YAML returns 200', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/schema/validate',
      headers: { 'content-type': 'text/plain' },
      payload: validYaml,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.valid).toBe(true);
  });

  it('POST /api/schema/validate with invalid YAML returns 400', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/schema/validate',
      headers: { 'content-type': 'text/plain' },
      payload: invalidYaml,
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('SCHEMA_INVALID');
  });

  it('PUT /api/schema with invalid YAML returns 400', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/schema',
      headers: { 'content-type': 'text/plain' },
      payload: invalidYaml,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('Schema routes - no schema loaded', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer({
      schemaService: new SchemaService('/tmp/nonexistent.yaml'),
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /api/schema returns 404 when no schema loaded', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/schema',
    });
    expect(response.statusCode).toBe(404);
  });
});

// Optimistic locking, ETag round-trip, and migration-preview need a real
// on-disk file so `currentHash` is non-null. These tests use a per-suite
// tempdir; tests that mutate the file (PUT, conflict) get fresh state
// rather than sharing.
describe('Schema routes - optimistic locking + migration preview', () => {
  let tmpDir: string;
  let schemaPath: string;
  let server: FastifyInstance;
  let initialHash: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-schema-'));
    schemaPath = join(tmpDir, 'schema.yaml');
    writeFileSync(schemaPath, validYaml, 'utf-8');
    const schemaService = new SchemaService(schemaPath);
    await schemaService.loadSchema();
    initialHash = schemaService.getHash() ?? '';
    server = await createServer({ schemaService });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/schema returns an ETag header', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/schema' });
    expect(res.statusCode).toBe(200);
    const etag = res.headers.etag;
    expect(typeof etag).toBe('string');
    // ETag is the hex hash, RFC 7232-style quoted.
    expect(etag).toBe(`"${initialHash}"`);
  });

  it('PUT with If-Match matching the current hash succeeds', async () => {
    // Tweak the schema slightly so the hash changes after write.
    const updated = stringifyYaml({
      ...DEFAULT_SCHEMA,
      node_types: {
        ...DEFAULT_SCHEMA.node_types,
        Phase3DummyType: {
          description: 'Test-only entity for hash round-trip.',
          properties: { id: { type: 'string', resolution_strategy: 'HIGHEST_CONFIDENCE' } },
        },
      },
    });
    const res = await server.inject({
      method: 'PUT',
      url: '/api/schema',
      headers: { 'content-type': 'text/yaml', 'if-match': `"${initialHash}"` },
      payload: updated,
    });
    expect(res.statusCode).toBe(200);
    // ETag should change post-write.
    const newEtag = res.headers.etag;
    expect(typeof newEtag).toBe('string');
    expect(newEtag).not.toBe(`"${initialHash}"`);
  });

  it('PUT with stale If-Match returns 409 + serverHash', async () => {
    // initialHash is no longer current after the previous test wrote new
    // content. Send it back to provoke a conflict.
    const res = await server.inject({
      method: 'PUT',
      url: '/api/schema',
      headers: { 'content-type': 'text/yaml', 'if-match': `"${initialHash}"` },
      payload: validYaml,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('VERSION_CONFLICT');
    expect(typeof body.serverHash).toBe('string');
    expect(body.serverHash.length).toBeGreaterThan(0);
    expect(body.serverHash).not.toBe(initialHash);
  });

  it('POST /api/schema/migration-preview returns impacts and skipped:true without neo4j', async () => {
    // Propose removing one of the existing node types — should surface a
    // remove_node_type impact. Without neo4j the affected count is null
    // and `skipped` is true.
    const proposed = stringifyYaml({
      ...DEFAULT_SCHEMA,
      node_types: Object.fromEntries(
        Object.entries(DEFAULT_SCHEMA.node_types).slice(1), // drop the first node type
      ),
      relationship_types: Object.fromEntries(
        Object.entries(DEFAULT_SCHEMA.relationship_types).filter(([, def]) => {
          const remaining = new Set(Object.keys(DEFAULT_SCHEMA.node_types).slice(1));
          return remaining.has(def.from) && remaining.has(def.to);
        }),
      ),
    });
    const res = await server.inject({
      method: 'POST',
      url: '/api/schema/migration-preview',
      headers: { 'content-type': 'text/yaml' },
      payload: proposed,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.skipped).toBe(true);
    expect(Array.isArray(body.impacts)).toBe(true);
    expect(body.impacts.length).toBeGreaterThan(0);
    // Every impact should have a null `affected` (no neo4j to check)
    // and an empty `samples` array.
    for (const impact of body.impacts) {
      expect(impact.affected).toBeNull();
      expect(impact.samples).toEqual([]);
    }
  });
});
