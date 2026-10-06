# ADR-031: The Feedback Widget Files Issues with a Service Identity

## Status

Accepted

## Date

2026-06-25

## Context

A "Report a problem" widget on every authenticated page files a GitHub issue in the product repository with the user's description, environment and recent console logs. Which GitHub identity files it? Reusing the signed-in user's GitHub token was asked for and examined.

## Decision

Issues are filed by a server-held fine-grained token (`FEEDBACK_GITHUB_TOKEN`, issues write) through the connector package's token authentication; the reporter is attributed in the issue body from the session, never from a GitHub token. Any signed-in user may submit; a per-user cooldown in Redis blunts spam; console logs are redacted of obvious secrets before they leave the browser. The `feedback` configuration section holds the target repository and labels; the real gate is a configured repository and a present token.

## Consequences

### Positive

- Works for every login provider, including OIDC and the local dev user, none of which has a GitHub token.

### Negative

- One shared credential; rotation is a secret version plus a restart.
- No screenshots in v1; GitHub's REST API cannot upload images.

### Neutral

- Attribution as the GitHub author would need a dedicated App.

## Alternatives Considered

### Reuse the user's login token

- **Cons:** The login token is discarded after the profile read, carries no repository scope, and portal users are customers, not collaborators on the product repository.

## References

- `docs/agent/decisions/feedback-widget-service-identity.md`
- `packages/api-server/src/routes/feedback.ts`
