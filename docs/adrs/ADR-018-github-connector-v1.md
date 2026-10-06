# ADR-018: GitHub Connector v1 — App-Only Auth, One Connector per Org, Per-Org Apps by Default

## Status

Accepted

## Date

2026-05-20 (per-org default and installation picker: 2026-05-24)

## Context

The GitHub connector began as a single-org proof of concept with PAT or GitHub App authentication, no persistence and a stubbed sync. Turning it into the first production connector raised the questions every later connector inherits: how it authenticates, how many orgs one connector covers, how freshness is kept, where its configuration and credentials live, and how a user gets an App without clicking through thirty permission checkboxes.

Two GitHub facts shaped the answers. A GitHub App installed into several orgs must be marked public and is then listed and installable by anyone; and the App manifest flow lets a tool create a correctly-configured App without ever holding the customer's credentials.

## Decision

1. **GitHub App authentication only.** The PAT path is gone: Apps give per-installation rate-limit budgets and a clean multi-org model.
2. **One connector instance per org.** `connectors.instances[]` in the config is a discriminated union, one entry per org, each with its own installation id, scope, schedule and sync status.
3. **Per-org App is the default; a shared App is opt-in.** A connector may carry its own `app: { id, privateKeyPath }`, resolved field by field over the global `connectors.github.app` by `resolveAppCredentials` (`packages/shared/src/config/schema.ts`). The Connector Hub wizard leads with the per-org path because a private App can only be installed into the account that owns it; the shared path warns that it requires a public App.
4. **App creation through the manifest flow.** The wizard's "Create App on GitHub" button posts GitHub's manifest form (`GET /api/connectors/github/manifest/launch`); the callback exchanges the code, writes the private key under the key directory with `chmod 600`, and lands the credentials either in the global slot (`target=global`) or in a nonce-keyed pending slot the wizard polls for the per-org instance (`target=instance`). A manual path stays behind a collapsed section.
5. **Installation picker for the shared path.** `GET /api/connectors/github/installations` lists the shared App's installations, marks the ones a connector already uses, and links to GitHub's install page; per-org mode enters the installation id by hand.
6. **Freshness by webhooks plus polling.** Polling reconciles whatever a missed delivery dropped (see ADR-030 for the receiver).
7. **Configuration is editable through the API** with the ETag pattern of ADR-016; connectors live at the root of the config (`connectors:`), not under `backend:`, because they are systems ShipIt reads from, not services it runs.
8. **Entity coverage** is Repository, Team, Person, Pipeline and CODEOWNERS edges; pull requests and issues become knowledge, not graph nodes (ADR-035).

## Consequences

### Positive

- Multi-org works without a public App, and a leaked key reads one org, not all of them.
- Setup is a click and a redirect; the tool never holds a customer's App credentials centrally.
- The same instance shape, factory and wizard pattern carried the Kubernetes connector (ADR-033).

### Negative

- Each org needs its own App unless the operator deliberately makes one public.
- The manifest flow needs a publicly reachable webhook URL; local development uses a relay.
- Repository, Team and Pipeline ids had to become org-scoped (ADR-021).

### Neutral

- The shared-App path remains for teams that want it (demo instances, a hosted tier).

## Alternatives Considered

### Keep PAT support as an escape hatch

- **Pros:** Quickest first sync.
- **Cons:** Single-user, low rate limit, expiring token, no multi-org story.

### One connector with a list of orgs

- **Pros:** One entry to configure.
- **Cons:** Per-org status, pause and scope become awkward; the per-instance shape stays clean.

### Shared App by default

- **Pros:** Credentials entered once.
- **Cons:** Requires a public App; the wizard steered users into a setup they could not finish.

## References

- `docs/agent/decisions/github-connector-architecture-v1.md`, `per-org-github-app-override.md`, `per-org-github-app-is-default-not-shared.md`, `github-app-manifest-flow.md`, `github-installation-picker.md`, `top-level-connectors-config-section.md`
- `docs/connectors/github-setup.md`
