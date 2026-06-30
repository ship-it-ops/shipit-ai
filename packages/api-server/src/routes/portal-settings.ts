// Admin Portal Settings hub (T6). Mounted at /api/settings.
//
// Thin routing layer over SettingsService + SetupService: every secret write
// lives in those services, the handlers only enforce admin-gating + the
// self-lockout guardrails and map service errors to status codes.
//
// EVERY handler first asserts request.ctx.user.role === 'admin' (config-export
// precedent). UI hiding is cosmetic; this is the real boundary. Secrets are
// never logged; the webhook secret is returned to the admin browser by design.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { InvalidOAuthClientError, InvalidAdminEmailError } from '../services/setup-service.js';
import { NoResolvableAppError, InvalidAllowlistEmailError } from '../services/settings-service.js';

// Shared admin gate. Returns true (and sends a 403) when the caller is not an
// admin, so handlers can `if (denyNonAdmin(...)) return;`.
function denyNonAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.ctx.user.role !== 'admin') {
    reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Admin role required.' } });
    return true;
  }
  return false;
}

const norm = (e: string): string => e.trim().toLowerCase();

// Derive the public webhook receiver URL from the incoming request, respecting
// reverse-proxy headers (same proto/host logic as manifestUrlsFromRequest in
// routes/connectors.ts). Used as the fallback when no `webhookPublicUrl` is
// configured, so the Receiver URL field is never blank on a reachable instance.
function receiverUrlFromRequest(request: FastifyRequest): string {
  const proto = (request.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = (request.headers['x-forwarded-host'] as string) ?? request.headers.host ?? '';
  return host ? `${proto}://${host}/api/webhooks/github` : '';
}

export async function portalSettingsRoutes(server: FastifyInstance): Promise<void> {
  // The settings hub is unusable without its backing service; fail loud at the
  // route level (503) rather than crashing per-handler if it wasn't wired.
  const requireServices = (reply: FastifyReply): boolean => {
    if (!server.settingsService || !server.setupService) {
      reply.status(503).send({
        error: {
          code: 'SETTINGS_DISABLED',
          message: 'Portal settings are not wired on this deployment.',
        },
      });
      return true;
    }
    return false;
  };

  // GET / — the full settings snapshot the admin UI renders.
  server.get('/', async (request, reply) => {
    if (denyNonAdmin(request, reply)) return;
    if (requireServices(reply)) return;
    const settings = server.settingsService!;
    return reply.send({
      webhookUrl: settings.getWebhookUrl(receiverUrlFromRequest(request)),
      webhooks: await settings.listWebhooks(),
      oauth: { configured: settings.getOAuthConfigured() },
      admins: settings.getAdmins(server.config?.accessControl.auth.admins ?? []),
      allowlist: settings.getAllowlist(),
    });
  });

  // POST /webhooks/:connectorId/setup and /rotate — same operation: generate +
  // persist a fresh per-App webhook secret, return it + paste-into-GitHub steps.
  const handleWebhookSecret = async (request: FastifyRequest, reply: FastifyReply) => {
    if (denyNonAdmin(request, reply)) return;
    if (requireServices(reply)) return;
    const { connectorId } = request.params as { connectorId: string };
    try {
      const result = await server.settingsService!.setConnectorWebhookSecret(
        connectorId,
        receiverUrlFromRequest(request),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof NoResolvableAppError) {
        return reply
          .status(400)
          .send({ error: { code: 'NO_RESOLVABLE_APP', message: err.message } });
      }
      throw err;
    }
  };
  server.post('/webhooks/:connectorId/setup', handleWebhookSecret);
  server.post('/webhooks/:connectorId/rotate', handleWebhookSecret);

  // PUT /oauth — persist the login OAuth App client id/secret.
  server.put('/oauth', async (request, reply) => {
    if (denyNonAdmin(request, reply)) return;
    if (requireServices(reply)) return;
    const { clientId, clientSecret } = (request.body ?? {}) as {
      clientId?: string;
      clientSecret?: string;
    };
    try {
      await server.setupService!.setOAuthClient(clientId ?? '', clientSecret ?? '');
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof InvalidOAuthClientError) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_OAUTH_CLIENT', message: err.message } });
      }
      throw err;
    }
  });

  // PUT /admins — replace the admin email list. Guardrail: the caller cannot
  // remove their own email (self-lockout → 422).
  server.put('/admins', async (request, reply) => {
    if (denyNonAdmin(request, reply)) return;
    if (requireServices(reply)) return;
    const { emails } = (request.body ?? {}) as { emails?: string[] };
    const list = Array.isArray(emails) ? emails : [];
    if (!list.map(norm).includes(norm(request.ctx.user.email))) {
      return reply.status(422).send({
        error: {
          code: 'SELF_LOCKOUT',
          message: 'You cannot remove your own email from the admin list.',
        },
      });
    }
    try {
      await server.setupService!.setAdminEmails(list);
      return reply.send({
        ok: true,
        admins: server.settingsService!.getAdmins(server.config?.accessControl.auth.admins ?? []),
      });
    } catch (err) {
      if (err instanceof InvalidAdminEmailError) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_ADMIN_EMAIL', message: err.message } });
      }
      throw err;
    }
  });

  // PUT /allowlist — replace the login allow-list. NO self-lockout guardrail
  // here (unlike /admins): admins ALWAYS bypass the allow-list (routes/auth.ts
  // "Admins bypass the allow-list"), so an admin editing it can never lock
  // themselves out, and forcing their own email into the list would block
  // legitimate curation. Emptying the list allows everyone — a valid choice the
  // UI confirms, not a lockout.
  server.put('/allowlist', async (request, reply) => {
    if (denyNonAdmin(request, reply)) return;
    if (requireServices(reply)) return;
    const { emails } = (request.body ?? {}) as { emails?: string[] };
    const list = Array.isArray(emails) ? emails : [];
    try {
      await server.settingsService!.setAllowlist(list);
      return reply.send({ ok: true, emails: server.settingsService!.getAllowlist() });
    } catch (err) {
      if (err instanceof InvalidAllowlistEmailError) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_ALLOWLIST_EMAIL', message: err.message } });
      }
      throw err;
    }
  });
}
