// GitHub webhook receiver (T5). POST /github (mounted at /api/webhooks).
//
// HMAC is the ENTIRE auth boundary for this route: it is in
// PUBLIC_PATH_PREFIXES + SETUP_PUBLIC_PATHS, so require-auth attaches an
// anonymous principal and never 401s it. The security invariants
// (INV-1..INV-5, docs/agent/plans/github-webhook-receiver.md) are encoded in
// the strict handler ordering below — read the comments before reordering.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { verifyGitHubWebhookSignature, type AppLike } from '@shipit-ai/shared';
import {
  resolveConnectorsByInstallation,
  resolveWebhookSecret,
} from '../services/webhook-resolution.js';

// The async refetch port the route depends on. WebhookRefetchQueue implements
// it; tests inject a fake. Kept minimal so a Redis-less unit server can run.
export interface WebhookRefetchPort {
  markDeliverySeen(id: string): Promise<boolean>;
  // Release a previously-marked delivery id so a redelivery is NOT deduped.
  // Called on the post-verify failure path: if we marked the delivery seen and
  // then enqueue failed (→ 5xx), GitHub redelivers — but the dedup key would
  // otherwise swallow it as a duplicate and the refetch would be lost. Releasing
  // the key keeps the "5xx means recoverable" contract intact.
  releaseDelivery(id: string): Promise<void>;
  enqueue(job: {
    connectorId: string;
    owner: string;
    repo: string;
    kind: 'repo' | 'workflows';
  }): Promise<void>;
  // Record the most recent VERIFIED delivery for a connector so the admin
  // Portal Settings webhook view can show "last verified delivery: <ts>".
  // Best-effort and observability-only — a failure here must never change the
  // delivery's HTTP response (the receiver wraps the call accordingly).
  recordVerifiedDelivery(rec: {
    connectorId: string;
    event: string;
    deliveryId: string;
    ts: string;
  }): Promise<void>;
  // Read back the last verified delivery for a connector (null when none has
  // been recorded, e.g. a fresh deployment).
  getLastVerifiedDelivery(
    connectorId: string,
  ): Promise<{ event: string; deliveryId: string; ts: string } | null>;
}

// ~2 MB cap — tightened from the global 5 MB. A normal push/workflow_run
// payload is well under this; an oversized body is rejected before hashing.
const WEBHOOK_BODY_LIMIT = 2 * 1024 * 1024;

// Pull owner/repo out of the (verified) payload. Prefers the explicit
// owner.login + name; falls back to splitting full_name ("owner/repo") so a
// payload shape that omits owner.login still routes.
function extractOwnerRepo(
  payload: Record<string, unknown>,
): { owner: string; repo: string } | null {
  const repository = payload['repository'] as Record<string, unknown> | undefined;
  if (!repository) return null;
  const ownerObj = repository['owner'] as Record<string, unknown> | undefined;
  const ownerLogin = typeof ownerObj?.['login'] === 'string' ? (ownerObj['login'] as string) : '';
  const name = typeof repository['name'] === 'string' ? (repository['name'] as string) : '';
  if (ownerLogin && name) return { owner: ownerLogin, repo: name };

  const fullName = typeof repository['full_name'] === 'string' ? repository['full_name'] : '';
  if (fullName) {
    const slash = fullName.indexOf('/');
    if (slash > 0 && slash < fullName.length - 1) {
      return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
    }
  }
  return null;
}

function readInstallationId(payload: Record<string, unknown>): number | string | null {
  const installation = payload['installation'] as Record<string, unknown> | undefined;
  const id = installation?.['id'];
  if (typeof id === 'number' || typeof id === 'string') return id;
  return null;
}

const webhookRoutes: FastifyPluginAsync = async (server) => {
  // ROUTE-SCOPED raw-body parser. Registered INSIDE this plugin's
  // encapsulation context, so it overrides application/json ONLY for routes in
  // this plugin and leaves the global JSON parser + the text/yaml string
  // parsers (server.ts) untouched. It stashes the exact bytes on req.rawBody
  // for HMAC, then JSON-parses for the normal body so the route still gets a
  // parsed object. A parse error here surfaces as a 400 before any handler
  // logic runs.
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      const buf = body as Buffer;
      done(null, buf.length ? JSON.parse(buf.toString('utf8')) : {});
    } catch (err) {
      done(err as Error);
    }
  });

  server.post(
    '/github',
    {
      bodyLimit: WEBHOOK_BODY_LIMIT,
      // INV-5: a burst of VERIFIED redeliveries must never be 429'd into a
      // non-2xx storm that makes GitHub auto-disable the webhook. HMAC is the
      // gate, so rate limiting is disabled on this route.
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const log = request.log;

      // ── STEP 1: header pre-check (before any hashing) ──────────────────
      const event = request.headers['x-github-event'];
      const deliveryId = request.headers['x-github-delivery'];
      const signature = request.headers['x-hub-signature-256'];
      if (
        typeof event !== 'string' ||
        typeof deliveryId !== 'string' ||
        typeof signature !== 'string'
      ) {
        return reply.status(400).send({
          error: { code: 'MISSING_WEBHOOK_HEADERS', message: 'Missing required GitHub headers.' },
        });
      }

      const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        // The route-scoped parser always sets rawBody; absence means a
        // non-JSON content type reached here. Treat as a malformed request.
        return reply.status(400).send({
          error: { code: 'MISSING_RAW_BODY', message: 'Expected a JSON webhook body.' },
        });
      }

      // ── STEP 2: parse a COPY of the UNTRUSTED body for the selector only ─
      // This installation.id is used ONLY to route to candidate secrets; it is
      // re-validated against the verified payload (step 6) before any state
      // change (INV-4).
      let selectorPayload: Record<string, unknown>;
      try {
        selectorPayload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      } catch {
        return reply.status(400).send({
          error: { code: 'INVALID_JSON', message: 'Webhook body is not valid JSON.' },
        });
      }
      const installationId = readInstallationId(selectorPayload);

      // ── STEP 3: route to connector(s) by installation id ───────────────
      const registry = server.connectorRegistry;
      const connectors = registry ? resolveConnectorsByInstallation(registry, installationId) : [];
      if (connectors.length === 0) {
        // INV-3: unknown installation NEVER verifies against the global secret
        // (no enumeration oracle) and NEVER 5xx (no GitHub auto-disable). 202 +
        // a distinct high-severity log line.
        //
        // The client-visible body is the SAME opaque {ok:true} as the
        // no-resolvable-secret case below: these are the two PRE-verification
        // 202s, reachable WITHOUT a valid signature, so a differing body would
        // let an unauthenticated caller enumerate which installation ids are
        // configured connectors. The distinction lives only in the server log.
        log.warn(
          { code: 'unknown_installation', installationId, event, deliveryId },
          'webhook: delivery for unknown installation id — acknowledged without action',
        );
        return reply.status(202).send({ ok: true });
      }

      // ── STEP 4: resolve candidate secrets (no downgrade, INV-3) ────────
      const globalApp: AppLike = server.config?.connectors.github.app ?? {};
      const candidates: { connector: (typeof connectors)[number]; secret: string }[] = [];
      for (const connector of connectors) {
        const resolved = resolveWebhookSecret(connector, globalApp, process.env);
        if (resolved.secret) candidates.push({ connector, secret: resolved.secret });
      }
      if (candidates.length === 0) {
        // No resolvable secret for any candidate connector. Do not 401-storm —
        // 202 + log (a misconfig the boot assertion should already flag). Same
        // opaque body as the unknown-installation case above (pre-verify, no
        // enumeration oracle); the distinction is in the server log only.
        log.warn(
          { code: 'no_resolvable_secret', installationId, event, deliveryId },
          'webhook: no resolvable webhook secret for installation — acknowledged without action',
        );
        return reply.status(202).send({ ok: true });
      }

      // ── STEP 5: VERIFY (the auth boundary) ─────────────────────────────
      // First action that can produce a non-2xx auth result. Try each
      // candidate secret until one verifies (rare multi-connector case).
      let matched: (typeof candidates)[number] | null = null;
      for (const candidate of candidates) {
        if (verifyGitHubWebhookSignature(rawBody, signature, candidate.secret)) {
          matched = candidate;
          break;
        }
      }
      if (!matched) {
        log.warn(
          { code: 'BAD_SIGNATURE', installationId, event, deliveryId },
          'webhook: signature verification failed',
        );
        return reply.status(401).send({
          error: { code: 'BAD_SIGNATURE', message: 'Webhook signature verification failed.' },
        });
      }

      // Everything past here is post-verification. An unexpected throw maps to
      // 5xx (so GitHub redelivers); it can never become a 2xx (INV-2).
      try {
        // ── STEP 6: re-parse VERIFIED bytes; assert selector matches ─────
        // We re-parse the exact verified bytes (not the selector copy) and
        // confirm the installation id we routed on equals the verified one
        // (INV-4 — a duplicate-key body can't diverge selector vs dispatch).
        const payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
        const verifiedInstallationId = readInstallationId(payload);
        if (
          installationId !== null &&
          verifiedInstallationId !== null &&
          String(verifiedInstallationId).trim() !== String(installationId).trim()
        ) {
          log.warn(
            { code: 'INSTALLATION_MISMATCH', installationId, verifiedInstallationId, deliveryId },
            'webhook: verified payload installation id does not match selector',
          );
          return reply.status(401).send({
            error: {
              code: 'INSTALLATION_MISMATCH',
              message: 'Verified payload installation id mismatch.',
            },
          });
        }

        const connector = matched.connector;

        // ── Record last-verified-delivery (observability only) ───────────
        // Now that the signature has verified, stamp the connector's
        // last-verified marker so the admin Portal Settings webhook view can
        // confirm a delivery actually landed. Best-effort: a record failure
        // (Redis down) must NEVER change the delivery's response — swallow it.
        if (server.webhookRefetch) {
          try {
            await server.webhookRefetch.recordVerifiedDelivery({
              connectorId: connector.id,
              event,
              deliveryId,
              ts: new Date().toISOString(),
            });
          } catch (recordErr) {
            log.warn(
              {
                code: 'last_verified_record_failed',
                deliveryId,
                err: (recordErr as Error).message,
              },
              'webhook: failed to record last-verified-delivery (non-fatal)',
            );
          }
        }

        // ── STEP 9 (early): disabled connector → ack, no enqueue ─────────
        if (!connector.enabled) {
          log.info(
            { code: 'connector_disabled', connectorId: connector.id, event, deliveryId },
            'webhook: verified delivery for disabled connector — acknowledged without refetch',
          );
          return reply.status(202).send({ ok: true, ignored: 'connector_disabled' });
        }

        const webhookRefetch = server.webhookRefetch;

        // ── STEP 7: delivery dedup (BEFORE refetch) ──────────────────────
        // Stops replay of a captured signed delivery. When the port isn't
        // wired (Redis-less unit server) we log + treat as new so verification
        // still exercises end-to-end.
        if (webhookRefetch) {
          const isNew = await webhookRefetch.markDeliverySeen(deliveryId);
          if (!isNew) {
            log.info(
              { code: 'duplicate_delivery', deliveryId, event },
              'webhook: duplicate delivery — acknowledged without refetch',
            );
            return reply.status(202).send({ ok: true, ignored: 'duplicate_delivery' });
          }
        } else {
          log.warn(
            { code: 'refetch_unwired', deliveryId, event },
            'webhook: refetch port not wired — verified but no dedup/enqueue',
          );
        }

        // ── STEP 8: dispatch by event type ───────────────────────────────
        if (event === 'ping') {
          return reply.status(200).send({ ok: true });
        }

        if (event === 'push' || event === 'workflow_run') {
          const ownerRepo = extractOwnerRepo(payload);
          if (!ownerRepo) {
            log.warn(
              { code: 'missing_repository', event, deliveryId },
              'webhook: verified delivery without resolvable repository — acknowledged',
            );
            return reply.status(202).send({ ok: true, ignored: 'missing_repository' });
          }
          const kind = event === 'push' ? 'repo' : 'workflows';
          if (webhookRefetch) {
            // Enqueue failure (Redis down) propagates → 5xx (caught below).
            // INV-5 still holds: a 5xx triggers GitHub redelivery; we never 429.
            await webhookRefetch.enqueue({
              connectorId: connector.id,
              owner: ownerRepo.owner,
              repo: ownerRepo.repo,
              kind,
            });
          }
          return reply.status(202).send({ ok: true, kind });
        }

        // pull_request, installation, installation_repositories, anything else
        // → verified + acked, no entity write (Cut A scope).
        log.info(
          { code: 'event_acknowledged', event, deliveryId, connectorId: connector.id },
          'webhook: verified delivery acknowledged (no Cut A action for this event)',
        );
        return reply.status(202).send({ ok: true, ignored: event });
      } catch (err) {
        // POST-verify failure (enqueue rejected, etc.) → 5xx so GitHub
        // redelivers. Never a 2xx (INV-2), never 429 (INV-5).
        //
        // CRITICAL: we already marked this delivery seen (STEP 7) before the
        // failure. If we leave the dedup key set, GitHub's redelivery (well
        // inside the 600s TTL) would hit STEP 7, see the key, and 202 it as a
        // duplicate — permanently losing the refetch. Release the key so the
        // redelivery is processed. Best-effort: a failed release just means the
        // redelivery dedups (degrades to the polling backstop), never worse.
        if (server.webhookRefetch) {
          try {
            await server.webhookRefetch.releaseDelivery(deliveryId);
          } catch (releaseErr) {
            log.error(
              { code: 'delivery_release_failed', deliveryId, err: (releaseErr as Error).message },
              'webhook: failed to release dedup key after processing failure',
            );
          }
        }
        log.error(
          { code: 'webhook_processing_failed', event, deliveryId, err: (err as Error).message },
          'webhook: processing failed after verification',
        );
        return reply.status(500).send({
          error: { code: 'WEBHOOK_PROCESSING_FAILED', message: 'Failed to process delivery.' },
        });
      }
    },
  );
};

export default webhookRoutes;
