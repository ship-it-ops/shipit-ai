// Agent definitions (mounted /api/agents). Definitions only: nothing here runs
// an agent. House style: manual body guards + { error: { code, message } }.
//
// Concurrency follows the editable-config ETag rule, with the row's integer
// `revision` as the ETag: GET returns ETag: "<revision>"; PUT/DELETE/publish
// honour If-Match and answer 409 VERSION_CONFLICT with the server's revision;
// a missing If-Match forces the write.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { hasCapability, type AiConfig } from '@shipit-ai/shared';
import {
  AgentBuiltinProtectedError,
  AgentNotFoundError,
  AgentSlugTakenError,
  AgentVersionConflictError,
  checkDefinitionAgainstPolicy,
  grantedServiceEffects,
  parseAgentDefinition,
  type AgentDefinition,
  type AgentRecord,
  type AgentStore,
  type DefinitionIssue,
  type ToolEffect,
  type UpdateAgentPatch,
} from '@shipit-ai/agents';
import { requireCapability } from '../middleware/require-auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    agentStore?: AgentStore;
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 2_000;
const MAX_TEAM_ID = 300;
const MAX_NOTE = 500;

interface Issue {
  path: string;
  code: string;
  message: string;
}

const actorOf = (request: FastifyRequest): string => request.ctx.user.email;

function setEtag(reply: FastifyReply, agent: AgentRecord): void {
  reply.header('ETag', `"${agent.revision}"`);
}

function invalid(reply: FastifyReply, issues: Issue[]): FastifyReply {
  return reply.status(400).send({
    error: { code: 'VALIDATION_ERROR', message: issues[0]?.message ?? 'Invalid request.' },
    issues,
  });
}

// Largest value of a Postgres `integer`. Revisions are stored as one, and a
// number past it reaching the driver is an error the routes would otherwise
// report as the database being down.
const PG_INT_MAX = 2_147_483_647;

/**
 * Reads If-Match as a revision. `undefined` (no header) forces the write;
 * `null` means the header was present but unusable.
 */
function parseIfMatch(header: unknown): number | undefined | null {
  if (header === undefined) return undefined;
  if (typeof header !== 'string') return null;
  const raw = header.replace(/^"|"$/g, '');
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const revision = Number(raw);
  return revision <= PG_INT_MAX ? revision : null;
}

function intParam(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(n, PG_INT_MAX) : undefined;
}

// Which capability the saving user must hold for a grant to be allowed. Only
// the graph has its own capabilities today; every other service is admin-only.
function capabilityFor(service: string, effect: ToolEffect): string {
  if (service === 'graph') return effect === 'read' ? 'graph:read' : 'graph:write';
  return 'ai:admin';
}

function replyForStoreError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): FastifyReply {
  if (err instanceof AgentNotFoundError) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: err.message } });
  }
  if (err instanceof AgentSlugTakenError) {
    return reply.status(409).send({ error: { code: 'SLUG_TAKEN', message: err.message } });
  }
  if (err instanceof AgentVersionConflictError) {
    return reply.status(409).send({
      error: { code: 'VERSION_CONFLICT', message: err.message },
      serverRevision: err.serverRevision,
    });
  }
  if (err instanceof AgentBuiltinProtectedError) {
    return reply.status(409).send({ error: { code: 'BUILTIN_PROTECTED', message: err.message } });
  }
  // Anything else is the store itself failing (database down, pool exhausted).
  // Log the real error; tell the caller only that agents are unavailable.
  request.log.error({ err }, 'agents: store error');
  return reply.status(503).send({
    error: { code: 'AI_UNAVAILABLE', message: 'The agent store is not reachable right now.' },
    checks: [{ name: 'database', ok: false, detail: 'The database is not reachable.' }],
  });
}

const agentsRoutes: FastifyPluginAsync = async (server) => {
  // Every handler starts here: no store, or a failing prerequisite, is a 503
  // that names what is missing. It is never a 500 and never a crash.
  async function ready(reply: FastifyReply): Promise<{ store: AgentStore; ai: AiConfig } | null> {
    const store = server.agentStore;
    const ai = server.config?.ai;
    const status = server.aiStatus ? await server.aiStatus.status() : null;
    if (!store || !ai || !status || !status.definitionsAvailable) {
      reply.status(503).send({
        error: {
          code: 'AI_UNAVAILABLE',
          message: 'Agent features are not available on this server.',
        },
        checks: status
          ? status.checks.filter((c) => !c.ok)
          : [
              {
                name: 'enabled',
                ok: false,
                detail: 'Agent features are not set up on this server.',
              },
            ],
      });
      return null;
    }
    return { store, ai };
  }

  // Shape check, then instance policy (known model, limits under the ceilings),
  // then the saving user's own ceiling. Replies and returns null on any failure.
  function validDefinition(
    request: FastifyRequest,
    reply: FastifyReply,
    ai: AiConfig,
    raw: unknown,
  ): AgentDefinition | null {
    const parsed = parseAgentDefinition(raw);
    if (!parsed.ok) {
      invalid(
        reply,
        parsed.issues.map((i: DefinitionIssue) => ({
          ...i,
          path: i.path ? `definition.${i.path}` : 'definition',
        })),
      );
      return null;
    }
    const policyIssues = checkDefinitionAgainstPolicy(parsed.definition, {
      modelKeys: ai.models.map((m) => m.key),
      ceilings: ai.limits,
    });
    if (policyIssues.length > 0) {
      invalid(
        reply,
        policyIssues.map((i) => ({ ...i, path: `definition.${i.path}` })),
      );
      return null;
    }
    const beyond = grantedServiceEffects(parsed.definition).filter(
      ({ service, effect }) => !hasCapability(request.ctx, capabilityFor(service, effect)),
    );
    if (beyond.length > 0) {
      reply.status(403).send({
        error: {
          code: 'GRANT_EXCEEDS_CAPABILITY',
          message: 'An agent cannot be granted access its author does not hold.',
        },
        issues: beyond.map(({ service, effect }) => ({
          path: `definition.grants.services.${service}.${effect}`,
          code: 'GRANT_EXCEEDS_CAPABILITY',
          message: `Granting ${effect} on ${service} requires the ${capabilityFor(service, effect)} capability.`,
        })),
      });
      return null;
    }
    return parsed.definition;
  }

  // Shared by create and update. `partial` makes every field optional.
  function readFields(
    body: Record<string, unknown>,
    partial: boolean,
  ): { issues: Issue[]; fields: Omit<UpdateAgentPatch, 'definition'> } {
    const issues: Issue[] = [];
    const fields: Omit<UpdateAgentPatch, 'definition'> = {};

    if (body.name !== undefined || !partial) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        issues.push({ path: 'name', code: 'INVALID', message: 'name is required.' });
      } else if (body.name.trim().length > MAX_NAME) {
        issues.push({
          path: 'name',
          code: 'INVALID',
          message: `name is at most ${MAX_NAME} characters.`,
        });
      } else {
        fields.name = body.name.trim();
      }
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string' || body.description.length > MAX_DESCRIPTION) {
        issues.push({
          path: 'description',
          code: 'INVALID',
          message: `description is text of at most ${MAX_DESCRIPTION} characters.`,
        });
      } else {
        fields.description = body.description;
      }
    }
    if (body.ownerTeamId !== undefined) {
      const v = body.ownerTeamId;
      if (v !== null && (typeof v !== 'string' || v.length === 0 || v.length > MAX_TEAM_ID)) {
        issues.push({
          path: 'ownerTeamId',
          code: 'INVALID',
          message: 'ownerTeamId is a team id or null.',
        });
      } else {
        fields.ownerTeamId = v as string | null;
      }
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        issues.push({ path: 'enabled', code: 'INVALID', message: 'enabled is true or false.' });
      } else {
        fields.enabled = body.enabled;
      }
    }
    return { issues, fields };
  }

  const asObject = (body: unknown): Record<string, unknown> | null =>
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;

  server.get<{ Querystring: { includeArchived?: string; limit?: string; offset?: string } }>(
    '/',
    { preHandler: requireCapability('agents:read') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      try {
        return await ctx.store.list({
          includeArchived: request.query.includeArchived === 'true',
          limit: intParam(request.query.limit),
          offset: intParam(request.query.offset),
        });
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireCapability('agents:read') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      try {
        const agent = await ctx.store.get(request.params.id);
        if (!agent) throw new AgentNotFoundError(request.params.id);
        setEtag(reply, agent);
        return agent;
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.get<{ Params: { id: string } }>(
    '/:id/versions',
    { preHandler: requireCapability('agents:read') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      try {
        const agent = await ctx.store.get(request.params.id);
        if (!agent) throw new AgentNotFoundError(request.params.id);
        return { items: await ctx.store.listVersions(agent.id) };
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.post<{ Body: unknown }>(
    '/',
    { preHandler: requireCapability('agents:write') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      const body = asObject(request.body);
      if (!body) {
        return invalid(reply, [
          { path: '', code: 'INVALID', message: 'A JSON object is required.' },
        ]);
      }
      const { issues, fields } = readFields(body, false);
      if (typeof body.slug !== 'string' || !SLUG.test(body.slug)) {
        issues.unshift({
          path: 'slug',
          code: 'INVALID',
          message:
            'slug is 1 to 63 lower-case letters, digits or dashes, starting with a letter or digit.',
        });
      }
      if (issues.length > 0) return invalid(reply, issues);
      const definition = validDefinition(request, reply, ctx.ai, body.definition);
      if (!definition) return reply;
      try {
        const agent = await ctx.store.create({
          slug: body.slug as string,
          name: fields.name!,
          description: fields.description,
          ownerTeamId: fields.ownerTeamId,
          definition,
          actor: actorOf(request),
        });
        setEtag(reply, agent);
        return reply.status(201).send(agent);
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.put<{ Params: { id: string }; Body: unknown }>(
    '/:id',
    { preHandler: requireCapability('agents:write') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      const expected = parseIfMatch(request.headers['if-match']);
      if (expected === null) {
        return invalid(reply, [
          {
            path: 'If-Match',
            code: 'INVALID',
            message: 'If-Match must be the agent revision, e.g. "3".',
          },
        ]);
      }
      const body = asObject(request.body);
      if (!body) {
        return invalid(reply, [
          { path: '', code: 'INVALID', message: 'A JSON object is required.' },
        ]);
      }
      const { issues, fields } = readFields(body, true);
      if (issues.length > 0) return invalid(reply, issues);
      const patch: UpdateAgentPatch = { ...fields };
      if (body.definition !== undefined) {
        const definition = validDefinition(request, reply, ctx.ai, body.definition);
        if (!definition) return reply;
        patch.definition = definition;
      }
      if (Object.keys(patch).length === 0) {
        return invalid(reply, [
          {
            path: '',
            code: 'INVALID',
            message:
              'Nothing to update: send name, description, ownerTeamId, enabled or definition.',
          },
        ]);
      }
      try {
        const agent = await ctx.store.update(request.params.id, expected, patch, actorOf(request));
        setEtag(reply, agent);
        return agent;
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.post<{ Params: { id: string }; Body: unknown }>(
    '/:id/publish',
    { preHandler: requireCapability('agents:write') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      const expected = parseIfMatch(request.headers['if-match']);
      if (expected === null) {
        return invalid(reply, [
          {
            path: 'If-Match',
            code: 'INVALID',
            message: 'If-Match must be the agent revision, e.g. "3".',
          },
        ]);
      }
      const note = asObject(request.body)?.note;
      if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) {
        return invalid(reply, [
          {
            path: 'note',
            code: 'INVALID',
            message: `note is text of at most ${MAX_NOTE} characters.`,
          },
        ]);
      }
      try {
        // The draft was valid when it was saved, but the instance's models and
        // ceilings may have changed since. Publishing re-checks, so a stale
        // draft cannot become the version triggers run.
        const current = await ctx.store.get(request.params.id);
        if (!current || current.archivedAt) throw new AgentNotFoundError(request.params.id);
        if (!validDefinition(request, reply, ctx.ai, current.draftDefinition)) return reply;
        const result = await ctx.store.publish(
          request.params.id,
          expected,
          (note as string | undefined) ?? '',
          actorOf(request),
        );
        setEtag(reply, result.agent);
        return result;
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireCapability('agents:write') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      const expected = parseIfMatch(request.headers['if-match']);
      if (expected === null) {
        return invalid(reply, [
          {
            path: 'If-Match',
            code: 'INVALID',
            message: 'If-Match must be the agent revision, e.g. "3".',
          },
        ]);
      }
      try {
        await ctx.store.archive(request.params.id, expected, actorOf(request));
        return reply.status(204).send();
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );
};

export default agentsRoutes;
