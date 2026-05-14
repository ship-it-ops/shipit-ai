// Phase 1: GET / PUT / POST /validate (already existed).
// Phase 2: GET /history, GET /history/:version, POST /diff, POST /rollback.
// No auth: schema edits are an operator action; Phase 3 RBAC will gate this.
import type { FastifyPluginAsync } from 'fastify';
import type { SchemaService } from '../services/schema-service.js';

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
    return schema;
  });

  server.put<{ Body: string; Querystring: { actor?: string } }>('/', async (request, reply) => {
    const yamlContent = request.body;
    if (!yamlContent || typeof yamlContent !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request body must be a YAML string' },
      });
    }
    try {
      const actor = request.query.actor ?? 'web-ui';
      const schema = await service.updateSchema(yamlContent, actor);
      return schema;
    } catch (err) {
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
      return schema;
    } catch (err) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: (err as Error).message },
      });
    }
  });
};

export default schemaRoutes;
