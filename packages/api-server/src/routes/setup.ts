// First-run setup wizard endpoints. Registered in BOTH modes — the
// handlers branch on server.setupMode:
//
//   - setup mode: reachable without auth (require-auth synthesizes an
//     admin-role setup principal for the allow-listed paths).
//   - active mode: GET /status stays useful (behind auth) for the
//     post-restart wizard poll and ops debugging; the mutating routes
//     409 SETUP_NOT_ACTIVE so a live deployment can never be "re-setup".
import type { FastifyPluginAsync } from 'fastify';
import { InvalidAdminEmailError, InvalidOAuthClientError } from '../services/setup-service.js';

const setupRoutes: FastifyPluginAsync = async (server) => {
  server.get('/status', async (_request, reply) => {
    const setupService = server.setupService;
    if (!setupService) {
      return reply.status(503).send({
        error: { code: 'SETUP_DISABLED', message: 'Setup service is not wired.' },
      });
    }
    const status = setupService.status(server.config);
    return {
      mode: server.setupMode ? 'setup' : 'active',
      gates: status.gates,
      ready: status.ready,
    };
  });

  // Tighter per-route limit than the global 200/min — these two write to
  // GSM / terminate the process and have no auth in setup mode.
  const mutatingRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  server.post<{ Body: { email?: unknown } }>(
    '/admin',
    { config: mutatingRateLimit },
    async (request, reply) => {
      const setupService = server.setupService;
      if (!setupService) {
        return reply.status(503).send({
          error: { code: 'SETUP_DISABLED', message: 'Setup service is not wired.' },
        });
      }
      if (!server.setupMode) {
        return reply.status(409).send({
          error: {
            code: 'SETUP_NOT_ACTIVE',
            message: 'This deployment has completed setup. Manage admins via configuration.',
          },
        });
      }
      const email = request.body?.email;
      if (typeof email !== 'string' || email.trim() === '') {
        return reply.status(400).send({
          error: { code: 'INVALID_EMAIL', message: 'Body must include an "email" string.' },
        });
      }
      try {
        await setupService.setAdminEmail(email);
      } catch (err) {
        if (err instanceof InvalidAdminEmailError) {
          return reply.status(400).send({
            error: { code: 'INVALID_EMAIL', message: err.message },
          });
        }
        throw err;
      }
      return { ok: true };
    },
  );

  server.post<{ Body: { clientId?: unknown; clientSecret?: unknown } }>(
    '/oauth',
    { config: mutatingRateLimit },
    async (request, reply) => {
      const setupService = server.setupService;
      if (!setupService) {
        return reply.status(503).send({
          error: { code: 'SETUP_DISABLED', message: 'Setup service is not wired.' },
        });
      }
      if (!server.setupMode) {
        return reply.status(409).send({
          error: {
            code: 'SETUP_NOT_ACTIVE',
            message:
              'This deployment has completed setup. Manage the login OAuth client via configuration.',
          },
        });
      }
      const { clientId, clientSecret } = request.body ?? {};
      if (
        typeof clientId !== 'string' ||
        clientId.trim() === '' ||
        typeof clientSecret !== 'string' ||
        clientSecret.trim() === ''
      ) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_OAUTH_CLIENT',
            message: 'Body must include non-empty "clientId" and "clientSecret" strings.',
          },
        });
      }
      try {
        await setupService.setOAuthClient(clientId, clientSecret);
      } catch (err) {
        if (err instanceof InvalidOAuthClientError) {
          return reply.status(400).send({
            error: { code: 'INVALID_OAUTH_CLIENT', message: err.message },
          });
        }
        throw err;
      }
      return { ok: true };
    },
  );

  server.post('/complete', { config: mutatingRateLimit }, async (_request, reply) => {
    const setupService = server.setupService;
    if (!setupService) {
      return reply.status(503).send({
        error: { code: 'SETUP_DISABLED', message: 'Setup service is not wired.' },
      });
    }
    if (!server.setupMode) {
      return reply.status(409).send({
        error: { code: 'SETUP_NOT_ACTIVE', message: 'This deployment has completed setup.' },
      });
    }
    const result = await setupService.complete();
    if (!result.ok) {
      return reply.status(409).send({
        error: {
          code: 'SETUP_INCOMPLETE',
          message: 'Setup is not finished — the next boot would still fail.',
          missing: result.missing,
          messages: result.messages,
        },
      });
    }
    // Reply first, then exit: the wizard needs the {ok:true} before the
    // pod goes away. k8s restartPolicy: Always brings it back in enforced
    // mode (the boot derivation sees the persisted secrets).
    server.log.info('setup complete — restarting into enforced-auth mode');
    setupService.scheduleRestart();
    return { ok: true };
  });
};

export default setupRoutes;
