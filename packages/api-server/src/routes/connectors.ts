// CRUD with ETag-based optimistic concurrency (mirrors /api/schema's pattern,
// see ADR-016). Per-instance hash is the strong validator; If-Match guards
// PATCH and DELETE so concurrent edits surface as 409 instead of silently
// clobbering each other. The probe endpoint validates credentials against the
// live GitHub API without writing anything.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath, sep } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { authenticateGitHubApp, createAppJWTOctokit } from '@shipit-ai/connector-github';
import { resolveAppCredentials } from '@shipit-ai/shared';

// Defense-in-depth: the probe endpoint accepts a privateKeyPath in its
// body (so the wizard's per-org override panel can validate creds
// without persisting). Without this allowlist, an attacker could pass
// `app.privateKeyPath: '/etc/passwd'` and have the server read + echo
// any file readable by the API process (CodeQL js/path-injection).
//
// The allowed directory is the same one the manifest service writes
// PEMs into — env-overridable for container deployments. Both the
// candidate and the allowed prefix are absolute-resolved so symlinks
// and `..` segments can't escape.
function getAllowedKeyDir(): string {
  return resolvePath(process.env.SHIPIT_GITHUB_APP_KEY_DIR ?? `${homedir()}/.shipit/keys`);
}

function isAllowedKeyPath(candidate: string): boolean {
  if (!candidate) return false;
  const allowed = getAllowedKeyDir();
  const resolved = resolvePath(candidate);
  return resolved === allowed || resolved.startsWith(allowed + sep);
}
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
  // Run history is hydrated server-side so the API contract stays the
  // same as before the YAML→Redis migration — clients still see
  // `lastRuns` populated on connector responses, but the data comes
  // from the run store, not from the YAML in-memory copy (which is now
  // always empty).
  const runStore = registry.getRunStore();

  // GET /api/connectors — list. Pipelines one Redis LRANGE per connector
  // (batched via listManyLatest) so 10 connectors cost one round trip,
  // not 10. No collection-level ETag; per-instance ETags are returned on
  // item GETs which is what the UI actually needs.
  server.get('/', async () => {
    const connectors = registry.list();
    const ids = connectors.map((c) => c.id);
    const runsById = await runStore.listManyLatest(ids);
    return connectors.map((c) => ({ ...c, lastRuns: runsById[c.id] ?? [] }));
  });

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

  // GET /api/connectors/github/installations — list every org/account the
  // shared App is installed in, plus the install URL for adding a new one.
  // The wizard's Connect step renders these as a picker so users don't
  // have to hunt for an installation ID in GitHub's UI (the #1 source of
  // "I picked the wrong org" confusion before this endpoint existed).
  //
  // Cross-references existing connector instances so each installation is
  // tagged with `usedByConnectorId` — the wizard surfaces this as an
  // "Already used by X" pill and a duplicate guard on the picker.
  //
  // Auth: app-JWT-only (no installation context) — required for the
  // `/app` and `/app/installations` endpoints, which authenticate as the
  // App itself rather than as one of its installations.
  server.get('/github/installations', async (request, reply) => {
    const appSvc = server.githubAppService;
    if (!appSvc) {
      return reply.status(503).send({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'GitHub App service is not configured on this server.',
        },
      });
    }
    const appStatus = appSvc.status();
    if (!appStatus.configured || !appStatus.id || !appStatus.privateKeyPath) {
      return reply.status(404).send({
        error: {
          code: 'NO_APP_CONFIGURED',
          message:
            'No global GitHub App is configured yet. Complete the App step of the wizard first.',
        },
      });
    }
    let privateKey: string;
    try {
      privateKey = readFileSync(appStatus.privateKeyPath, 'utf-8');
    } catch (err) {
      return reply.status(400).send({
        error: {
          code: 'PRIVATE_KEY_UNREADABLE',
          message: `Failed to read App private key at ${appStatus.privateKeyPath}: ${(err as Error).message}`,
        },
      });
    }

    const octokit = createAppJWTOctokit({ appId: appStatus.id, privateKey });
    try {
      const [appResp, instResp] = await Promise.all([
        octokit.rest.apps.getAuthenticated(),
        octokit.rest.apps.listInstallations({ per_page: 100 }),
      ]);
      const app = appResp.data;
      const installs = instResp.data;
      // Map installationId → connectorId for the "Already used by" pill.
      // installationId is stored as a string on connector instances; cast
      // GitHub's numeric id to string for the lookup.
      const usedBy = new Map<string, string>();
      for (const c of registry.list()) {
        if (c.installationId) usedBy.set(c.installationId, c.id);
      }
      // Always use the slug-based PUBLIC install URL — appending
      // /installations/new to html_url breaks for org-owned Apps because
      // html_url is the App's settings page within the owner org
      // (`/organizations/<org>/settings/apps/<slug>`), and GitHub redirects
      // `/installations/new` on that URL to the EXISTING installation in
      // that same org instead of showing the account picker. The public
      // `/apps/<slug>/installations/new` form always shows the picker so
      // the user can install into any org they admin.
      const slug = app?.slug ?? '';
      const installUrl = slug
        ? `https://github.com/apps/${slug}/installations/new`
        : `${app?.html_url ?? 'https://github.com'}/installations/new`;
      return reply.send({
        appSlug: slug,
        appName: app?.name ?? '',
        installUrl,
        installations: installs.map((inst) => {
          const account = inst.account as {
            login?: string;
            type?: string;
            avatar_url?: string;
          } | null;
          const accountType = account?.type === 'User' ? 'User' : 'Organization';
          return {
            id: inst.id,
            account: {
              login: account?.login ?? 'unknown',
              type: accountType as 'User' | 'Organization',
              avatarUrl: account?.avatar_url ?? '',
            },
            targetType: (inst.target_type as 'User' | 'Organization') ?? accountType,
            repositorySelection: (inst.repository_selection as 'all' | 'selected') ?? 'selected',
            usedByConnectorId: usedBy.get(String(inst.id)) ?? null,
          };
        }),
      });
    } catch (err) {
      request.log.error({ err }, 'installations: GitHub API failed');
      const upstreamStatus = (err as { status?: number }).status;
      const code = upstreamStatus === 401 ? 'BAD_PRIVATE_KEY' : 'GITHUB_API_ERROR';
      return reply.status(502).send({
        error: { code, message: (err as Error).message },
      });
    }
  });

  // GET /api/connectors/github/manifest — JSON manifest spec, primarily
  // for inspection ("what does the wizard send to GitHub?"). NOT what
  // gets sent to GitHub — see /manifest/launch below for the actual
  // submission path. This endpoint just lets a curious admin curl the
  // manifest and audit the permissions/events the wizard will request.
  server.get('/github/manifest', async (request, reply) => {
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
    const { webhookUrl, redirectUrl } = manifestUrlsFromRequest(server, request);
    const result = svc.buildManifest({ webhookUrl, redirectUrl });
    reply.header('Cache-Control', 'private, max-age=30');
    // For the JSON debug view, return the manifest + a sibling
    // `_warnings` array so curl users see why hook_attributes is absent.
    if (result.webhookOmitted) {
      return {
        ...result.manifest,
        _warnings: {
          webhookOmitted: true,
          reason: result.webhookOmissionReason,
        },
      };
    }
    return result.manifest;
  });

  // GET /api/connectors/github/manifest/launch?owner=<org-or-blank> —
  // The real entry point. Returns an HTML page with an auto-submitting
  // <form method="POST" action="https://github.com/.../settings/apps/new
  // ?state=..."> whose body carries the manifest JSON in a `manifest`
  // field. The browser POSTs to GitHub, GitHub renders the App-creation
  // page with EVERY field pre-filled (this is the part our previous
  // manifest_url= query-string approach got wrong — GitHub never reads
  // that param; it requires a form POST).
  //
  // Wizard's "Create App on GitHub" button just does
  // `window.open(this URL, '_blank')` — same-origin, no popup-blocker
  // issues, no async state token roundtrip needed in the click handler.
  server.get<{ Querystring: { owner?: string; target?: string; nonce?: string } }>(
    '/github/manifest/launch',
    async (request, reply) => {
      const svc = server.githubAppManifestService;
      const appSvc = server.githubAppService;
      if (!svc || !appSvc) {
        return reply
          .status(503)
          .type('text/html')
          .send(
            renderLaunchErrorHtml(
              'GitHub App manifest service unavailable',
              'This ShipIt instance is not configured for the manifest flow. Use the manual setup path instead.',
            ),
          );
      }

      const { webhookUrl, redirectUrl } = manifestUrlsFromRequest(server, request);
      const built = svc.buildManifest({ webhookUrl, redirectUrl });
      // Per-org card passes `target=instance&nonce=<uuid>` so the
      // callback knows NOT to write credentials to the global slot
      // (which would surprise users who picked per-org explicitly).
      // Default is 'global' to preserve the existing shared-mode flow.
      const target = request.query.target === 'instance' ? 'instance' : 'global';
      const nonce = target === 'instance' ? (request.query.nonce ?? '').trim() : undefined;
      // Nonce validation is loose — wizard generates a UUID, but we don't
      // require any particular shape, just non-empty and reasonably
      // bounded so an attacker can't blow up the pendingInstance map.
      if (target === 'instance' && (!nonce || nonce.length < 8 || nonce.length > 128)) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            renderLaunchErrorHtml(
              'Missing nonce',
              'Target=instance launches require a nonce (8-128 chars) so the wizard can claim the credentials. Refresh the wizard and retry.',
            ),
          );
      }
      const state = svc.issueState({ target, nonce });

      // Owner: empty → personal account, otherwise the org login slug.
      // We validate softly (loose pattern) so a totally bogus value
      // shows up as a 404 on GitHub's side rather than a 500 here.
      const owner = (request.query.owner ?? '').trim();
      const ownerOk = owner === '' || /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner);
      if (!ownerOk) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            renderLaunchErrorHtml(
              'Invalid owner',
              `"${escapeHtml(owner)}" doesn't look like a GitHub org login. Org logins use letters, digits, and dashes; max 39 chars.`,
            ),
          );
      }
      const actionUrl =
        owner === ''
          ? `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`
          : `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${encodeURIComponent(state)}`;

      reply.header('Cache-Control', 'no-store');
      return reply.type('text/html').send(
        renderLaunchHtml({
          actionUrl,
          manifest: built.manifest,
          webhookOmitted: built.webhookOmitted,
          webhookOmissionReason: built.webhookOmissionReason,
          webhookUrl,
        }),
      );
    },
  );

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
      const stateInfo = svc.consumeState(state);
      if (!stateInfo) {
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
        const result = await svc.exchangeAndPersist(code, {
          target: stateInfo.target,
          nonce: stateInfo.nonce,
        });
        // Compose the post-success page. Surface the PEM path, webhook
        // secret file, and install URL so the user has everything they
        // need to finish wiring up webhook delivery + close the loop.
        // The body copy differs slightly between targets: for the
        // global path the user needs to come back to the wizard which
        // is polling app-status; for the instance path the wizard is
        // polling the pending-instance endpoint with its nonce and
        // will auto-fill the override fields when it sees the result.
        const continueCopy =
          stateInfo.target === 'instance'
            ? `<p>Your wizard tab is polling for these credentials and will fill them into the per-org override fields automatically — switch back to it now.</p>`
            : `<p>The shared GitHub App is now configured. Your wizard can continue.</p>`;
        return reply.type('text/html').send(
          renderCallbackHtml({
            ok: true,
            heading: `App "${escapeHtml(result.appName)}" created`,
            body: `
              ${continueCopy}
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

  // GET /api/connectors/github/manifest/pending-instance/:nonce —
  // claim credentials stashed by a target='instance' manifest callback.
  // The wizard generates a nonce client-side, threads it through the
  // launch URL, and polls this endpoint while the user is in the
  // GitHub tab. When credentials are returned (200), the wizard fills
  // the per-org `overrideAppId` + `overrideKeyPath` fields and clears
  // the polling state. Single-use: a second GET for the same nonce
  // returns 404.
  server.get<{ Params: { nonce: string } }>(
    '/github/manifest/pending-instance/:nonce',
    async (request, reply) => {
      const svc = server.githubAppManifestService;
      if (!svc) {
        return reply.status(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'GitHub App manifest service is not configured on this server.',
          },
        });
      }
      const claimed = svc.consumePendingInstance(request.params.nonce);
      if (!claimed) {
        // 404 is the polling signal — wizard keeps polling until
        // either credentials arrive or it gives up (timeout). Not an
        // error condition.
        return reply.status(404).send({
          error: { code: 'NOT_READY', message: 'No pending credentials for this nonce yet.' },
        });
      }
      return reply.send(claimed);
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
  //
  // Per-route rate limit (tighter than the global default): probe hits the
  // filesystem (private key) AND the GitHub API per call — an unbounded
  // loop would chew through Octokit's per-IP budget and our FS handles.
  // 30 req/min/IP is plenty for a human filling out the wizard.
  server.post<{ Body: ProbeBody }>(
    '/probe',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
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

      // Only constrain paths supplied via the request body. The global App
      // path comes from server config (operator-controlled) — operators
      // can legitimately point at /etc/shipit/keys/… or other absolute
      // paths, and locking that down would be a config break.
      const userSuppliedKeyPath = request.body?.app?.privateKeyPath;
      if (userSuppliedKeyPath && !isAllowedKeyPath(userSuppliedKeyPath)) {
        return reply.status(400).send({
          ok: false,
          code: 'PRIVATE_KEY_PATH_NOT_ALLOWED',
          message:
            'privateKeyPath must point inside the configured keys directory ' +
            '(SHIPIT_GITHUB_APP_KEY_DIR, default ~/.shipit/keys).',
        });
      }

      let privateKey: string;
      try {
        privateKey = readFileSync(resolved.privateKeyPath, 'utf-8');
      } catch (err) {
        // Log details server-side; the response intentionally omits the
        // path + raw error message so a probe failure doesn't echo
        // operator filesystem layout to the caller.
        request.log.warn(
          { err, path: resolved.privateKeyPath },
          'probe: failed to read App private key',
        );
        return reply.status(400).send({
          ok: false,
          code: 'PRIVATE_KEY_UNREADABLE',
          message: 'Failed to read App private key. Check the API server logs for details.',
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
    },
  );

  // GET /api/connectors/:id — detail with ETag header for subsequent PATCH.
  // ETag is computed on the *configuration* shape only — lastRuns now
  // lives in Redis and would flap on every poll, defeating optimistic
  // concurrency on the user-edited fields if it were part of the hash.
  server.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const c = registry.get(request.params.id);
    reply.header('ETag', `"${registry.getHash(c.id)}"`);
    const lastRuns = await runStore.listRuns(c.id);
    return { ...c, lastRuns };
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
        // Hydrate lastRuns from the run store so PATCH responses match
        // the shape GET returns; otherwise the UI's local cache would
        // briefly show empty run history after every edit.
        const lastRuns = await runStore.listRuns(updated.id);
        return { ...updated, lastRuns };
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
  // Reads straight from the run store; the registry just confirms the
  // connector exists (404 otherwise) so a request for a deleted id
  // returns the right status code instead of an empty array.
  server.get<{ Params: { id: string } }>('/:id/runs', async (request) => {
    const c = registry.get(request.params.id);
    const runs = await runStore.listRuns(c.id);
    return { connectorId: c.id, runs };
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

// Compute the manifest's webhook + redirect URLs from runtime config and
// the incoming request. Webhook URL is the saved `webhookPublicUrl`;
// redirect URL falls out of the request's host (respecting reverse-proxy
// headers) so a deployment behind an ingress with TLS termination still
// produces the right callback URL.
function manifestUrlsFromRequest(
  server: FastifyInstance,
  request: FastifyRequest,
): { webhookUrl: string; redirectUrl: string } {
  const cfg = (server as unknown as { config?: Config }).config;
  const webhookUrl =
    cfg?.connectors.github.app.webhookPublicUrl ?? 'http://localhost:3001/api/webhooks/github';
  const proto = (request.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = (request.headers['x-forwarded-host'] as string) ?? request.headers.host ?? '';
  const redirectUrl = `${proto}://${host}/api/connectors/github/app-manifest-callback`;
  return { webhookUrl, redirectUrl };
}

// HTML wrapper for the auto-submitting manifest form. Same-origin, served
// from the API; the inline script POSTs to github.com on load. We escape
// the manifest JSON the JavaScript-safe way (not just HTML-escape) to
// avoid breaking out of the string literal — </script> in a value would
// otherwise terminate the script block early.
function renderLaunchHtml(args: {
  actionUrl: string;
  manifest: unknown;
  webhookOmitted: boolean;
  webhookOmissionReason?: string;
  webhookUrl: string;
}): string {
  // JSON.stringify on a value followed by safe substitution of `</` is
  // the standard guard against embedded close-script-tags in JSON.
  const manifestJson = JSON.stringify(args.manifest).replace(/<\//g, '<\\/');
  // When the webhook URL isn't publicly reachable, hold the auto-submit
  // and show the user a yellow banner explaining what's happening. They
  // either proceed without webhook config (button → submit) or close the
  // tab, set GITHUB_WEBHOOK_PUBLIC_URL to a smee channel, and retry.
  const holdSubmit = args.webhookOmitted;
  const warningHtml = args.webhookOmitted
    ? `<div class="warn">
        <strong>Webhooks and event subscriptions will be skipped.</strong>
        <p>Your configured webhook URL — <code>${escapeHtml(args.webhookUrl)}</code> — ${escapeHtml(args.webhookOmissionReason ?? '')}. GitHub rejects webhook URLs it can't reach from the public internet, and it also rejects event subscriptions without a valid webhook URL.</p>
        <p>The App will be created with the correct permissions (Repository, Members, etc.), but <strong>no event subscriptions and no webhook URL</strong>. After creation you can add both via GitHub's App settings once you have a public webhook URL — or close this tab now, set <code>GITHUB_WEBHOOK_PUBLIC_URL</code> to a smee.io / ngrok / public ingress URL, restart the API server, and re-run the wizard for the full one-click experience.</p>
        <button type="button" id="continue-btn">Continue to GitHub (permissions only)</button>
      </div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>ShipIt-AI · Launching GitHub</title>
    <style>
      body { font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0e1116; color: #e8eaed; padding: 48px 24px; }
      .card { max-width: 560px; margin: 0 auto; background: #151a21; border: 1px solid #232a33; border-radius: 12px; padding: 32px; text-align: center; }
      h1 { font-size: 16px; margin: 0 0 12px; }
      p { color: #9ba3ad; font-size: 13px; }
      .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #4ea1ff; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -3px; margin-right: 8px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      noscript { color: #ffb454; }
      form { margin-top: 16px; }
      button { background: #4ea1ff; color: #061018; border: 0; padding: 10px 18px; border-radius: 6px; font-size: 13px; cursor: pointer; font-weight: 600; }
      .warn { text-align: left; background: #2a1f0a; border: 1px solid #6b4a07; color: #f4d57a; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
      .warn p { color: #d6c08d; margin: 8px 0; }
      .warn strong { color: #ffd87a; }
      code { background: #0a0d12; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #cbd2d9; }
    </style>
  </head><body><div class="card">
    ${warningHtml}
    ${holdSubmit ? '' : '<h1><span class="spinner"></span>Opening GitHub…</h1><p>Sending the App manifest to github.com. You\'ll see the App-creation page with all permissions and events pre-filled.</p>'}
    <form id="manifest-form" method="POST" action="${escapeHtml(args.actionUrl)}">
      <input type="hidden" name="manifest" />
      <noscript>
        <p>This page normally submits automatically. JavaScript is disabled — click below to continue:</p>
        <button type="submit">Continue to GitHub</button>
      </noscript>
    </form>
    <script>
      var manifest = ${manifestJson};
      var form = document.getElementById('manifest-form');
      form.elements['manifest'].value = JSON.stringify(manifest);
      var holdSubmit = ${holdSubmit ? 'true' : 'false'};
      if (holdSubmit) {
        // User explicitly chose to proceed without webhook configured.
        // The continue button submits the form when clicked.
        var btn = document.getElementById('continue-btn');
        if (btn) btn.addEventListener('click', function () { form.submit(); });
      } else {
        form.submit();
      }
    </script>
  </div></body></html>`;
}

function renderLaunchErrorHtml(heading: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ShipIt-AI · Manifest error</title>
    <style>
      body { font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0e1116; color: #e8eaed; padding: 48px 24px; }
      .card { max-width: 480px; margin: 0 auto; background: #151a21; border: 1px solid #232a33; border-radius: 12px; padding: 32px; }
      h1 { font-size: 16px; margin: 0 0 12px; color: #c63838; }
      p { color: #cbd2d9; font-size: 13px; }
    </style>
  </head><body><div class="card"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p></div></body></html>`;
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
