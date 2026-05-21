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
import type { GitHubAppManifestService } from '../services/github-app-manifest-service.js';
import type { Config } from '@shipit-ai/shared';

declare module 'fastify' {
  interface FastifyInstance {
    connectorRegistry: ConnectorRegistry;
    githubAppService?: GitHubAppService;
    githubAppManifestService?: GitHubAppManifestService;
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

  // GET /api/connectors/github/manifest — dynamic App manifest with this
  // instance's webhook URL + callback URL substituted in. The wizard
  // posts this URL as `manifest_url=...` to github.com so the user lands
  // on a pre-filled "Create GitHub App" page with all permissions/events
  // and OUR webhook URL already configured.
  //
  // Public — contains zero secrets, just a schema describing what the
  // App should look like. The `state` query string is the CSRF token
  // that GitHub will echo back on the callback for verification.
  server.get<{ Querystring: { state?: string } }>('/github/manifest', async (request, reply) => {
    const svc = server.githubAppManifestService;
    const appSvc = server.githubAppService;
    if (!svc || !appSvc) {
      return reply.status(503).send({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'GitHub App manifest service is not configured on this server.',
        },
      });
    }
    // Build the redirect URL from the API's own base. The webhook URL
    // comes from the saved config (`webhookPublicUrl`) — it's the
    // ingress for GitHub→ShipIt webhooks, which is the user's
    // responsibility to make publicly reachable.
    const cfg = (server as unknown as { config?: Config }).config;
    const webhookUrl =
      cfg?.connectors.github.app.webhookPublicUrl ?? 'http://localhost:3001/api/webhooks/github';
    // We accept the redirect URL relative to whatever the caller
    // declares — the wizard tells us its origin in the state query so
    // a deployed UI on a different host than the API still works.
    // Default to the API's own host for local-dev convenience.
    const proto = (request.headers['x-forwarded-proto'] as string) ?? 'http';
    const host = (request.headers['x-forwarded-host'] as string) ?? request.headers.host ?? '';
    const redirectUrl = `${proto}://${host}/api/connectors/github/app-manifest-callback`;

    const manifest = svc.buildManifest({ webhookUrl, redirectUrl });
    // Cache-Control: short — the URLs can change at runtime if the
    // admin updates `webhookPublicUrl`. 30s is enough for one user's
    // round-trip without serving stale data after a config change.
    reply.header('Cache-Control', 'private, max-age=30');
    return manifest;
  });

  // POST /api/connectors/github/manifest/state — issue a CSRF state
  // token for the manifest round-trip. The wizard calls this just
  // before redirecting the user to GitHub.
  server.post('/github/manifest/state', async (_request, reply) => {
    const svc = server.githubAppManifestService;
    if (!svc) {
      return reply.status(503).send({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'GitHub App manifest service is not configured on this server.',
        },
      });
    }
    const token = svc.issueState();
    return { state: token };
  });

  // GET /api/connectors/github/app-manifest-callback — the URL GitHub
  // redirects to after the user creates the App from our manifest.
  // Exchanges the one-time `code` for the App's credentials (App ID +
  // PEM + webhook secret), writes the PEM to disk, persists via
  // GitHubAppService, then redirects the user back to /connectors so
  // the wizard can resume.
  //
  // Returns HTML rather than JSON because GitHub navigates the user's
  // browser to this URL — they'll see whatever we render.
  server.get<{ Querystring: { code?: string; state?: string } }>(
    '/github/app-manifest-callback',
    async (request, reply) => {
      const svc = server.githubAppManifestService;
      if (!svc) {
        return reply
          .status(503)
          .type('text/html')
          .send(
            renderCallbackHtml({
              ok: false,
              heading: 'GitHub App manifest service unavailable',
              body: 'This ShipIt instance is not configured to receive the GitHub App manifest callback. Contact the operator.',
            }),
          );
      }

      const { code, state } = request.query;
      if (!code) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            renderCallbackHtml({
              ok: false,
              heading: 'Missing code',
              body: 'GitHub did not return a code on the callback. Re-run the wizard from /connectors.',
            }),
          );
      }
      if (!svc.consumeState(state)) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            renderCallbackHtml({
              ok: false,
              heading: 'Invalid or expired state token',
              body: "The CSRF state token didn't match what we issued, or it expired (tokens last 15 minutes). Re-run the wizard.",
            }),
          );
      }

      try {
        const result = await svc.exchangeAndPersist(code);
        // Compose the post-success page. Surface the PEM path, webhook
        // secret file, and install URL so the user has everything they
        // need to finish wiring up webhook delivery + close the loop.
        return reply.type('text/html').send(
          renderCallbackHtml({
            ok: true,
            heading: `App "${escapeHtml(result.appName)}" created`,
            body: `
              <p>The shared GitHub App is now configured. Your wizard can continue.</p>
              <dl>
                <dt>App ID</dt><dd><code>${escapeHtml(result.appId)}</code></dd>
                <dt>Private key</dt><dd><code>${escapeHtml(result.privateKeyPath)}</code></dd>
                <dt>Webhook secret</dt><dd><code>${escapeHtml(result.webhookSecretPath)}</code></dd>
              </dl>
              <p>
                Wire the webhook secret into your environment:<br/>
                <code>export GITHUB_WEBHOOK_SECRET=$(cat ${escapeHtml(result.webhookSecretPath)})</code><br/>
                Then install the App on your org from
                <a href="${escapeHtml(result.installUrl)}/installations/new" target="_blank" rel="noreferrer">GitHub</a>.
              </p>
              <p><a href="/connectors?from=app-manifest">Return to ShipIt-AI →</a></p>
            `,
          }),
        );
      } catch (err) {
        request.log.error({ err }, 'manifest exchange failed');
        return reply
          .status(502)
          .type('text/html')
          .send(
            renderCallbackHtml({
              ok: false,
              heading: 'Exchange failed',
              body: `GitHub couldn't be reached or returned an error: <code>${escapeHtml((err as Error).message)}</code>. Re-run the wizard.`,
            }),
          );
      }
    },
  );

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

// ── HTML helpers for the manifest callback ─────────────────────────────
// GitHub navigates the browser to the callback URL, so we render HTML
// rather than JSON. Kept inline (not a templating engine) because the
// page is small and one-shot — adding a templater here would be overkill.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCallbackHtml(args: { ok: boolean; heading: string; body: string }): string {
  const tone = args.ok ? '#0ea05c' : '#c63838';
  return `<!doctype html><html><head><meta charset="utf-8"><title>ShipIt-AI · GitHub App</title>
    <style>
      body { font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0e1116; color: #e8eaed; padding: 48px 24px; }
      .card { max-width: 640px; margin: 0 auto; background: #151a21; border: 1px solid #232a33; border-radius: 12px; padding: 32px; }
      h1 { font-size: 18px; margin: 0 0 16px; color: ${tone}; }
      a { color: #4ea1ff; }
      code { background: #0a0d12; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 13px; margin: 16px 0; }
      dt { color: #9ba3ad; font-family: ui-monospace, monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 1.2px; align-self: center; }
      dd { margin: 0; word-break: break-all; }
      p { color: #cbd2d9; }
    </style>
  </head><body><div class="card"><h1>${escapeHtml(args.heading)}</h1>${args.body}</div></body></html>`;
}

export default connectorRoutes;
