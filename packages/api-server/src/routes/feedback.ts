// In-app "Report a problem" widget backend (mounted /api/feedback).
//
// Any signed-in user may file a report; the global require-auth preHandler
// already populates request.ctx.user, which we use to attribute the reporter.
// House style: manual body guards + { error: { code, message } } envelope
// (mirrors routes/portal-settings.ts). The issue is filed by a server-held
// service identity (see FeedbackService) — never the user's GitHub token.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FEEDBACK_TYPES,
  FeedbackDisabledError,
  IssueCreateError,
  type FeedbackContext,
  type FeedbackLog,
  type FeedbackType,
} from '../services/feedback-service.js';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_LOGS = 200;

function badRequest(reply: FastifyReply, message: string): void {
  reply.status(400).send({ error: { code: 'INVALID_FEEDBACK', message } });
}

// Defensive coercion of the untrusted browser payload into the typed shapes
// FeedbackService expects. Unknown fields are dropped.
function coerceContext(raw: unknown): FeedbackContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.slice(0, 500) : undefined;
  return {
    url: str(r.url),
    route: str(r.route),
    userAgent: str(r.userAgent),
    viewport: str(r.viewport),
    language: str(r.language),
    appVersion: str(r.appVersion),
  };
}

function coerceLogs(raw: unknown): FeedbackLog[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const logs: FeedbackLog[] = [];
  for (const item of raw.slice(0, MAX_LOGS)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const level = typeof r.level === 'string' ? r.level.slice(0, 16) : 'log';
    const message = typeof r.message === 'string' ? r.message : '';
    const ts = typeof r.ts === 'number' ? r.ts : undefined;
    logs.push({ level, message, ts });
  }
  return logs;
}

export async function feedbackRoutes(server: FastifyInstance): Promise<void> {
  // Lets the web-ui hide the launcher when feedback isn't configured. Any
  // signed-in user (the global require-auth gate already applies).
  server.get('/config', async (_request, reply) => {
    return reply.send({ enabled: server.feedbackService?.isEnabled() ?? false });
  });

  server.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const service = server.feedbackService;
    if (!service || !service.isEnabled()) {
      return reply.status(503).send({
        error: {
          code: 'FEEDBACK_DISABLED',
          message: 'Feedback is not configured on this deployment.',
        },
      });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const type = body.type;
    if (typeof type !== 'string' || !FEEDBACK_TYPES.includes(type as FeedbackType)) {
      return badRequest(reply, `type must be one of: ${FEEDBACK_TYPES.join(', ')}.`);
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return badRequest(reply, 'A title is required.');
    if (title.length > MAX_TITLE)
      return badRequest(reply, `Title must be ${MAX_TITLE} characters or fewer.`);
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) return badRequest(reply, 'A description is required.');
    if (description.length > MAX_DESCRIPTION) {
      return badRequest(reply, `Description must be ${MAX_DESCRIPTION} characters or fewer.`);
    }

    // Per-user cooldown to blunt spam. No-op without Redis.
    const allowed = await service.checkRateLimit(request.ctx.user.id);
    if (!allowed) {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Please wait a moment before submitting another report.',
        },
      });
    }

    try {
      const result = await service.createReport({
        type: type as FeedbackType,
        title,
        description,
        context: coerceContext(body.context),
        logs: coerceLogs(body.logs),
        reporter: {
          email: request.ctx.user.email,
          displayName: request.ctx.user.displayName,
          provider: request.ctx.user.provider,
          role: request.ctx.user.role,
        },
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof FeedbackDisabledError) {
        return reply
          .status(503)
          .send({ error: { code: 'FEEDBACK_DISABLED', message: err.message } });
      }
      if (err instanceof IssueCreateError) {
        // Don't leak the upstream GitHub error verbatim to the browser.
        request.log.error({ err }, 'feedback issue creation failed');
        return reply.status(502).send({
          error: {
            code: 'ISSUE_CREATE_FAILED',
            message: 'Could not file the report. Please try again later.',
          },
        });
      }
      throw err;
    }
  });
}

export default feedbackRoutes;
