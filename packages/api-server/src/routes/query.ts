// Phase 2: Query Playground.
// Read-only Cypher endpoint backing /explore/query. The query text passes
// `checkReadOnlyCypher` (the check the graph_query MCP tool also applies), and
// what passes is run by `CypherQueryService` in a read-access transaction with
// a timeout and a row limit. Any authenticated caller may use it.
import type { FastifyPluginAsync } from 'fastify';
import { checkReadOnlyCypher, type ReadOnlyCypherVerdict } from '@shipit-ai/shared';
import { ReadOnlyQueryError } from '@shipit-ai/mcp-server/cypher';
import { CypherQueryService } from '../services/cypher-query-service.js';
import type { Neo4jService } from '../services/neo4j-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    neo4jService: Neo4jService;
  }
}

type Refusal = Extract<ReadOnlyCypherVerdict, { ok: false }>;

// WRITE_BLOCKED is what the Query Playground shows its read-only notice for:
// a write clause, or a CALL that is not allowed. Every other refusal is a
// query the caller has to rephrase.
function refusalCode(refusal: Refusal): 'WRITE_BLOCKED' | 'VALIDATION_ERROR' {
  return refusal.code === 'WRITE_KEYWORD' || refusal.code === 'PROCEDURE'
    ? 'WRITE_BLOCKED'
    : 'VALIDATION_ERROR';
}

function failure(err: unknown): { status: 400 | 504; code: string; message: string } {
  const message = (err as Error).message;
  if (err instanceof ReadOnlyQueryError) {
    if (err.kind === 'timeout') return { status: 504, code: 'QUERY_TIMEOUT', message };
    if (err.kind === 'write_refused') return { status: 400, code: 'WRITE_BLOCKED', message };
  }
  return { status: 400, code: 'CYPHER_ERROR', message };
}

const queryRoutes: FastifyPluginAsync = async (server) => {
  const service = new CypherQueryService(
    server.neo4jService.getDriver(),
    server.config.backend.cypherQuery,
  );

  server.post<{
    Body: { cypher?: unknown; params?: unknown };
  }>('/', async (request, reply) => {
    const { cypher, params } = request.body ?? {};

    if (typeof cypher !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: '`cypher` must be a string' },
      });
    }
    if (params !== undefined && (typeof params !== 'object' || params === null)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: '`params` must be an object' },
      });
    }

    const verdict = checkReadOnlyCypher(cypher);
    if (!verdict.ok) {
      return reply.status(400).send({
        error: {
          code: refusalCode(verdict),
          message: verdict.message,
          keyword: verdict.keyword,
        },
      });
    }

    try {
      const result = await service.execute(cypher, (params as Record<string, unknown>) ?? {});
      return result;
    } catch (err) {
      const { status, code, message } = failure(err);
      return reply.status(status).send({ error: { code, message } });
    }
  });
};

export default queryRoutes;
