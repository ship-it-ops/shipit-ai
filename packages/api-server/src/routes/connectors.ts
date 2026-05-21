// CRUD with ETag-based optimistic concurrency (mirrors /api/schema's pattern,
// see ADR-016). Per-instance hash is the strong validator; If-Match guards
// PATCH and DELETE so concurrent edits surface as 409 instead of silently
// clobbering each other. The probe endpoint validates credentials against the
// live GitHub API without writing anything.
import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { authenticateGitHubApp } from '@shipit-ai/connector-github';
import { resolveAppCredentials } from '@shipit-ai/shared';
import {
  ConnectorVersionConflictError,
  type ConnectorRegistry,
} from '../services/connector-registry.js';
import {
  GitHubAppVersionConflictError,
  type GitHubAppService,
} from '../services/github-app-service.js';
import type { Config } from '@shipit-ai/shared';

declare module 'fastify' {
  interface FastifyInstance {
    connectorRegistry: ConnectorRegistry;
    githubAppService?: GitHubAppService;
  }
}

// Strip RFC 7232 quoted-string wrapping the same way the schema route does.
function parseIfMatch(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  return header.replace(/^"|"$/g, '');
}

interface CreateConnectorBody {
  id: string;
  type: 'github';
  name: string;
  enabled?: boolean;
  installationId: string;
  org: string;
  schedule?: string;
  scope?: unknown;
  entities?: unknown;
  // Optional per-connector App override. Wizard sends this only when the
  // "Use a separate GitHub App" advanced panel is filled in; otherwise the
  // connector inherits connectors.github.app.*.
  app?: { id?: string; privateKeyPath?: string };
}

interface UpdateConnectorBody {
  enabled?: boolean;
  name?: string;
  schedule?: string;
  scope?: unknown;
  entities?: unknown;
  // Set to null to clear an existing override and fall back to global App.
  app?: { id?: string; privateKeyPath?: string } | null;
}

interface ProbeBody {
  installationId: string;
  suggestedOrg?: string;
  // Same shape as connector.app — when present, the probe uses these
  // credentials INSTEAD of the global App. Lets the wizard validate a
  // separate-App setup before creating the connector.
  app?: { id?: string; privateKeyPath?: string };
}

const connectorRoutes: FastifyPluginAsync = async (server) => {
  const registry = server.connectorRegistry;

  // GET /api/connectors — list. No collection-level ETag; per-instance
  // ETags are returned on item GETs which is what the UI actually needs.
  server.get('/', async () => registry.list());

  // ── Global GitHub App ────────────────────────────────────────────────
  // GET /api/connectors/github/app — current status. Used by the wizard
  // to decide between "ask the user to configure a shared App" (first
  // connector) and "offer the existing shared App" (subsequent ones).
  // ETag accompanies so an admin's edit doesn't race the wizard's write.
  server.get('/github/app', async (_request, reply) => {
    const svc = server.githubAppService;
    if (!svc) {
      return reply.status(503).send({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'GitHub App service is not configured on this server.',
        },
      });
    }
    reply.header('ETag', `"${svc.getHash()}"`);
    return svc.status();
  });

  // PUT /api/connectors/github/app — set/update the shared App. Writes
  // `connectors.github.app.id` + `connectors.github.app.privateKeyPath`
  // into shipit.config.local.yaml and mutates the in-memory config so
  // the scheduler picks up the change without a restart.
  server.put<{ Body: { id: string; privateKeyPath: string } }>(
    '/github/app',
    async (request, reply) => {
      const svc = server.githubAppService;
      if (!svc) {
        return reply.status(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'GitHub App service is not configured on this server.',
          },
        });
      }
      const ifMatch = parseIfMatch(request.headers['if-match']);
      try {
        const updated = await svc.update(request.body ?? ({} as never), ifMatch);
        reply.header('ETag', `"${svc.getHash()}"`);
        return updated;
      } catch (err) {
        if (err instanceof GitHubAppVersionConflictError) {
          return reply.status(409).send({
            error: { code: 'VERSION_CONFLICT', message: err.message },
            serverHash: err.serverHash,
          });
        }
        const status = (err as { statusCode?: number }).statusCode ?? 400;
        return reply
          .status(status)
          .send({ error: { code: 'VALIDATION_ERROR', message: (err as Error).message } });
      }
    },
  );

  // POST /api/connectors — create. 201 on success, 409 if id already exists,
  // 400 on validation failure (Zod error from the registry).
  server.post<{ Body: CreateConnectorBody }>('/', async (request, reply) => {
    const body = request.body;
    if (!body || !body.id || body.type !== 'github' || !body.name) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'id, type ("github"), and name are required',
        },
      });
    }
    if (!body.installationId || !body.org) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'installationId and org are required for github connectors',
        },
      });
    }
    try {
      const created = await registry.create({
        id: body.id,
        type: 'github',
        name: body.name,
        enabled: body.enabled,
        installationId: body.installationId,
        org: body.org,
        schedule: body.schedule,
        // `scope`/`entities` come through unknown to keep the route ignorant
        // of the schema shape; the registry runs them through Zod.
        scope: body.scope as never,
        entities: body.entities as never,
        app: body.app,
      });
      reply.header('ETag', `"${registry.getHash(created.id)}"`);
      return reply.status(201).send(created);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      return reply.status(status).send({
        error: {
          code: status === 409 ? 'DUPLICATE' : 'VALIDATION_ERROR',
          message: (err as Error).message,
        },
      });
    }
  });

  // POST /api/connectors/probe — pre-creation credential check. Constructs a
  // transient Octokit, hits the installation endpoint, lists a handful of
  // repos. Returns structured failure codes so the wizard can map each to a
  // user-actionable message instead of dumping a stack trace.
  server.post<{ Body: ProbeBody }>('/probe', async (request, reply) => {
    const { installationId, suggestedOrg } = request.body ?? ({} as ProbeBody);
    if (!installationId) {
      return reply.status(400).send({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'installationId is required',
      });
    }

    const cfg = (server as unknown as { config?: Config }).config;
    const globalApp = cfg?.connectors.github.app ?? { id: '', privateKeyPath: '' };
    // Probe resolution: the request's `app` field overrides the global one
    // field-by-field. Lets the wizard's advanced panel test a per-org App
    // without leaving the create flow.
    const resolved = resolveAppCredentials({ app: request.body?.app }, globalApp);
    if (!resolved.id || !resolved.privateKeyPath) {
      return reply.status(400).send({
        ok: false,
        code: 'APP_NOT_CONFIGURED',
        message: resolved.overridden
          ? 'The override App is missing id or privateKeyPath. Both fields are required when overriding.'
          : 'GitHub App is not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH ' +
            'in your environment, or supply an override `app` in this request.',
      });
    }

    let privateKey: string;
    try {
      privateKey = readFileSync(resolved.privateKeyPath, 'utf-8');
    } catch (err) {
      return reply.status(400).send({
        ok: false,
        code: 'PRIVATE_KEY_UNREADABLE',
        message: `Failed to read App private key at ${resolved.privateKeyPath}: ${(err as Error).message}`,
      });
    }

    // Reuse the connector's own auth helper so we don't drift between probe
    // and live sync. It returns a per-installation Octokit ready for the
    // discovery calls below.
    const { auth, octokit } = await authenticateGitHubApp({
      appId: resolved.id,
      privateKey,
      installationId,
    });
    if (!auth.success || !octokit) {
      return reply.status(400).send({
        ok: false,
        code: 'AUTH_FAILED',
        message: auth.error ?? 'GitHub App authentication failed',
      });
    }

    try {
      // The installation account name doubles as the default org hint for
      // the wizard's "pick org" step when the caller didn't supply one.
      const inst = await octokit.rest.apps.getInstallation({
        installation_id: Number(installationId),
      });
      const account = inst.data.account as { login?: string; type?: string } | null;
      const org = suggestedOrg ?? account?.login ?? '';

      let sampleRepos: Array<{ name: string; private: boolean; archived: boolean }> = [];
      let repoCount = 0;
      try {
        const repos = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 5 });
        repoCount = repos.data.total_count;
        sampleRepos = repos.data.repositories.map(
          (r: { name: string; private: boolean; archived?: boolean }) => ({
            name: r.name,
            private: r.private,
            archived: r.archived ?? false,
          }),
        );
      } catch (err) {
        // Probe still succeeds — auth worked, we just couldn't enumerate
        // repos. Surface as a warning rather than a hard fail.
        request.log.warn({ err }, 'probe: listReposAccessibleToInstallation failed');
      }

      return reply.send({
        ok: true,
        installation: {
          id: installationId,
          account: account?.login ?? null,
          accountType: account?.type ?? null,
          repoCount,
        },
        suggestedOrg: org,
        sampleRepos,
        // Echo back which App credentials were used so the wizard's
        // "Advanced" panel can confirm an override actually took effect.
        app: { id: resolved.id, overridden: resolved.overridden },
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      let code: string = 'PROBE_FAILED';
      if (status === 401) code = 'BAD_PRIVATE_KEY';
      else if (status === 403) code = 'INSUFFICIENT_PERMISSIONS';
      else if (status === 404) code = 'INSTALLATION_NOT_FOUND';
      return reply.status(status === 404 ? 404 : 400).send({
        ok: false,
        code,
        message: (err as Error).message,
      });
    }
  });

  // GET /api/connectors/:id — detail with ETag header for subsequent PATCH.
  server.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const c = registry.get(request.params.id);
    reply.header('ETag', `"${registry.getHash(c.id)}"`);
    return c;
  });

  // PATCH /api/connectors/:id — partial update. If-Match required when the
  // client has a hash; absent header is treated as "force write" which is
  // useful for the wizard's initial-add flow but the UI sends If-Match for
  // every other edit.
  server.patch<{ Params: { id: string }; Body: UpdateConnectorBody }>(
    '/:id',
    async (request, reply) => {
      const ifMatch = parseIfMatch(request.headers['if-match']);
      try {
        const updated = await registry.update(
          request.params.id,
          {
            enabled: request.body?.enabled,
            name: request.body?.name,
            schedule: request.body?.schedule,
            scope: request.body?.scope as never,
            entities: request.body?.entities as never,
            app: request.body?.app,
          },
          ifMatch,
        );
        reply.header('ETag', `"${registry.getHash(updated.id)}"`);
        return updated;
      } catch (err) {
        if (err instanceof ConnectorVersionConflictError) {
          return reply.status(409).send({
            error: { code: 'VERSION_CONFLICT', message: err.message },
            serverHash: err.serverHash,
          });
        }
        const status = (err as { statusCode?: number }).statusCode ?? 400;
        return reply.status(status).send({
          error: {
            code: status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR',
            message: (err as Error).message,
          },
        });
      }
    },
  );

  // DELETE /api/connectors/:id — same If-Match rule as PATCH.
  server.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const ifMatch = parseIfMatch(request.headers['if-match']);
    try {
      await registry.remove(request.params.id, ifMatch);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof ConnectorVersionConflictError) {
        return reply.status(409).send({
          error: { code: 'VERSION_CONFLICT', message: err.message },
          serverHash: err.serverHash,
        });
      }
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      return reply.status(status).send({
        error: {
          code: status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR',
          message: (err as Error).message,
        },
      });
    }
  });

  // POST /api/connectors/:id/sync — enqueue an out-of-band sync. The runner
  // does the work; this endpoint returns the *initial* status snapshot only.
  server.post<{ Params: { id: string }; Body: { mode?: 'full' | 'incremental' } }>(
    '/:id/sync',
    async (request, reply) => {
      try {
        const mode = request.body?.mode ?? 'full';
        return await registry.triggerSync(request.params.id, mode);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        return reply.status(status).send({
          error: {
            code: status === 404 ? 'NOT_FOUND' : 'SYNC_FAILED',
            message: (err as Error).message,
          },
        });
      }
    },
  );

  // GET /api/connectors/:id/status — live runtime status from the runner.
  server.get<{ Params: { id: string } }>('/:id/status', async (request) => {
    return registry.getStatus(request.params.id);
  });

  // GET /api/connectors/:id/runs — persisted run history (last 20).
  server.get<{ Params: { id: string } }>('/:id/runs', async (request) => {
    const c = registry.get(request.params.id);
    return { connectorId: c.id, runs: c.lastRuns ?? [] };
  });
};

export default connectorRoutes;
