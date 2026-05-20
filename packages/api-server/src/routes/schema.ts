// Phase 1: GET / PUT / POST /validate (already existed).
// Phase 2: GET /history, GET /history/:version, POST /diff, POST /rollback.
// Phase 3: optimistic locking (ETag / If-Match), POST /migration-preview.
// No auth: schema edits are an operator action; Phase 3 RBAC will gate this.
import type { FastifyPluginAsync } from 'fastify';
import { SchemaVersionConflictError, type SchemaService } from '../services/schema-service.js';
import { buildMigrationPreview } from '../services/schema-migration-preview.js';

declare module 'fastify' {
  interface FastifyInstance {
    schemaService: SchemaService;
  }
}

const schemaRoutes: FastifyPluginAsync = async (server) => {
  const service = server.schemaService;

  server.get('/', async (_request, reply) => {
    const schema = service.getSchema();
    if (!schema) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'No schema loaded' },
      });
    }
    // ETag carries the optimistic-locking token. Clients hand it back via
    // If-Match on PUT so we can reject blind overwrites.
    const hash = service.getHash();
    if (hash) reply.header('ETag', `"${hash}"`);
    return schema;
  });

  server.put<{ Body: string; Querystring: { actor?: string } }>('/', async (request, reply) => {
    const yamlContent = request.body;
    if (!yamlContent || typeof yamlContent !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request body must be a YAML string' },
      });
    }
    // Strip the quoted-string wrapping that browsers add per RFC 7232.
    const rawIfMatch = request.headers['if-match'];
    const ifMatch = typeof rawIfMatch === 'string' ? rawIfMatch.replace(/^"|"$/g, '') : undefined;
    try {
      const actor = request.query.actor ?? 'web-ui';
      const schema = await service.updateSchema(yamlContent, actor, ifMatch);
      const hash = service.getHash();
      if (hash) reply.header('ETag', `"${hash}"`);
      return schema;
    } catch (err) {
      if (err instanceof SchemaVersionConflictError) {
        return reply.status(409).send({
          error: { code: 'VERSION_CONFLICT', message: err.message },
          serverHash: err.serverHash,
        });
      }
      return reply.status(400).send({
        error: { code: 'SCHEMA_INVALID', message: (err as Error).message },
      });
    }
  });

  server.post<{ Body: string }>('/validate', async (request, reply) => {
    const yamlContent = request.body;
    if (!yamlContent || typeof yamlContent !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request body must be a YAML string' },
      });
    }
    const result = service.validateSchema(yamlContent);
    if (!result.valid) {
      return reply.status(400).send({
        error: { code: 'SCHEMA_INVALID', message: result.error },
      });
    }
    return { valid: true, schema: result.schema };
  });

  server.post<{ Body: string }>('/diff', async (request, reply) => {
    const yamlContent = request.body;
    if (!yamlContent || typeof yamlContent !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request body must be a YAML string' },
      });
    }
    try {
      return service.diffAgainstCurrent(yamlContent);
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'SCHEMA_INVALID', message: (err as Error).message },
      });
    }
  });

  server.post<{ Body: string }>('/migration-preview', async (request, reply) => {
    const yamlContent = request.body;
    if (!yamlContent || typeof yamlContent !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request body must be a YAML string' },
      });
    }
    try {
      const diff = service.diffAgainstCurrent(yamlContent);
      // Without Neo4j the preview can still return the structural list — it
      // just reports `affected: null` for each impact so the UI shows the
      // surface without misleading "0 affected" placeholders.
      const preview = await buildMigrationPreview(diff, service.getSchema(), server.neo4jService);
      return preview;
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'SCHEMA_INVALID', message: (err as Error).message },
      });
    }
  });

  server.get('/history', async () => {
    return service.getHistory();
  });

  server.get<{ Params: { version: string } }>('/history/:version', async (request, reply) => {
    const yaml = await service.getSnapshot(request.params.version);
    if (yaml === null) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Snapshot ${request.params.version} not found` },
      });
    }
    return reply.type('text/yaml').send(yaml);
  });

  server.post<{
    Body: { version?: unknown };
    Querystring: { actor?: string };
  }>('/rollback', async (request, reply) => {
    const { version } = request.body ?? {};
    if (typeof version !== 'string' || !version) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: '`version` must be a string' },
      });
    }
    try {
      const actor = request.query.actor ?? 'web-ui';
      const schema = await service.rollbackTo(version, actor);
      const hash = service.getHash();
      if (hash) reply.header('ETag', `"${hash}"`);
      return schema;
    } catch (err) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: (err as Error).message },
      });
    }
  });
};

export default schemaRoutes;
