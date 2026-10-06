# ADR-030: GitHub Webhook Receiver — Verify First, Refetch, Never Downgrade a Secret

## Status

Accepted

## Date

2026-06-18

## Context

Freshness came from polling alone; the receiver route did not exist. ADR-018 always intended webhooks plus polling. The open question was how to resolve the webhook secret when most connectors use their own App (ADR-018) and therefore their own secret.

## Decision

`POST /api/webhooks/github` is on the public path allow-list; the HMAC signature is the entire authentication boundary, and the handler order is the security contract:

1. Check the GitHub headers are present.
2. Parse a copy of the unverified body for the `installation.id` selector only.
3. Route to the connector(s) through a per-request index of installation ids (never cached). Unknown: an opaque 202.
4. Resolve the secret: the per-App sidecar materialised from the connector blob (ADR-025); the global secret only for connectors on the global App. A per-org connector without a sidecar is never downgraded to the global secret.
5. Verify the signature over the raw bytes. This is the first non-2xx authentication result.
6. Re-parse the verified bytes and assert the selector matches.
7. Deduplicate the delivery id in Redis before any work.
8. Dispatch: `push` and `workflow_run` enqueue a coalesced refetch of the affected entity through the existing normalisers onto the event bus; `ping` answers 200; everything else is verified and logged.

Processing is a targeted refetch, not payload translation; polling remains the reconciliation backstop. The route is reachable in setup mode so GitHub never sees a 401 storm that auto-disables the webhook, and verified deliveries are never rate-limited.

## Consequences

### Positive

- Nothing state-changing happens before verification; pre-verification responses leak nothing.
- Per-App secrets need no environment-variable scheme; they ride the connector blob.

### Negative

- A delivery for an entity type that is not refetched (pull requests today) is only logged.
- Out-of-order deliveries can clobber until content freshness guards land.

### Neutral

- Local development points the App's webhook at a relay to `localhost:3001/api/webhooks/github`.

## Alternatives Considered

### Translate payloads directly into canonical entities

- **Cons:** A payload is not a full entity; drift risk and per-event mappers.

### Refetch synchronously in the request

- **Cons:** Blocks the handler on a GitHub round trip; redelivery storms fan out.

## References

- `docs/agent/decisions/webhook-receiver-design.md`
- `packages/api-server/src/routes/webhooks.ts`
