# ADR-014: Layered Local Configuration (`shipit.config.yaml` + `shipit.config.local.yaml`)

## Status

Accepted

## Date

2026-05-20

## Context

Phase 1 (ADR-003) ran with a single `.env` file plus a small `config.ts` in each package. Two pain points pushed us to revisit that:

1. **No clean separation of shared defaults from per-developer overrides.** Every contributor edited the same `.env` — secrets, dev-user identity, integration subdomains all in one file. New contributors had no canonical source for "what does the default look like" because the file was always personalized.
2. **No shared shape between backend and frontend.** The API server, the core writer, the MCP server, and the web UI each parsed `process.env` directly. Adding a new field meant updating four parsers, four type definitions, and four READMEs. There was no compile-time error when a key was renamed in one place and not another.

We also have a more specific constraint: the Next.js web UI inlines `process.env.NEXT_PUBLIC_*` literals at build time (bundler-level dead-code substitution). Per-request configuration that the browser bundle reads has to be present as `NEXT_PUBLIC_*` env vars when `next build` (or `next dev`) starts — not at request time.

We considered several approaches (alternatives below) and landed on a two-file YAML layout with deep-merge, env-var substitution, and a `frontend.*` subtree that gets flattened into `NEXT_PUBLIC_*` vars at build time.

## Decision

ShipIt-AI's local configuration is stored in two YAML files at the repo root:

- **`shipit.config.yaml`** — committed. Shared defaults: the canonical shape of every config key, sensible non-secret values, env-var placeholders (`${NEO4J_PASSWORD:-shipit-dev}`) for anything that _should_ vary per machine.
- **`shipit.config.local.yaml`** — gitignored. Per-developer overrides. Bootstrapped from `shipit.config.local.example.yaml` (committed) by `scripts/preflight.sh` on first run, then never auto-modified by tooling beyond the in-UI onboarding modal (see ADR-015).

**Merge semantics.** `loadConfig()` in `packages/shared/src/config/loader.ts` deep-merges the local file _on top of_ the base file. Arrays are replaced wholesale (not concatenated); objects are merged recursively. The merged tree is then validated against a Zod schema in `packages/shared/src/config/schema.ts`. Validation failure throws with the failing path — no half-typed config silently flows through the system.

**Env-var substitution.** Any string value matching `${NAME}` or `${NAME:-default}` is replaced with the process-env value, with optional fallback. Missing variables without a fallback throw at load time. This is the seam for secrets: `password: ${NEO4J_PASSWORD}` keeps the secret in `process.env` (typically sourced from `.env` or a real secret store in non-local environments), while `shipit.config.yaml` is committed and readable.

**Frontend subtree.** The `frontend.*` subtree is the public part of the config — anything the browser bundle is allowed to read. `next.config.mjs` re-implements the YAML load + deep-merge + env-substitution locally (because turbo runs packages in parallel and `@shipit-ai/shared` may not be built when `next.config.mjs` evaluates), then flattens the subtree into `NEXT_PUBLIC_SHIPIT_<UPPER_SNAKE_PATH>` env vars. `packages/web-ui/src/lib/client-config.ts` reads those vars with literal `process.env.NEXT_PUBLIC_*` references so Next.js's bundler can inline the values.

**Schema as the contract.** `packages/shared/src/config/schema.ts` is the single source of truth for the shape. Backend packages import the typed `Config` (`backend.*` plus `frontend.*`); the web UI's `client-config.ts` keeps a parallel TS interface for `frontend.*` (necessary because shared can't be imported at Next-build evaluation time, per above). Adding a key means editing the Zod schema, the example YAML, and either the web UI's `ClientConfig` interface (if it's a frontend key) or the api-server's consumer (if it's a backend key).

**The `.env` file is for secrets only.** Anything that's not a secret moves into `shipit.config.yaml`. `.env` continues to hold values that need to live in `process.env` for tooling reasons (Neo4j driver, third-party SDKs that read from env directly).

## Consequences

### Positive

- **One canonical shape, type-checked end to end.** Adding a config key updates the Zod schema and ripples through the typed `Config` consumed by every backend package.
- **Clean defaults / overrides split.** Fresh checkouts get sensible behavior from `shipit.config.yaml` alone. The local file is for personalization, not for "what does this app need to run".
- **Per-developer customization stops leaking into PRs.** `.local.yaml` is gitignored; the dev-user identity, integration subdomains, and password overrides never appear in diffs.
- **Frontend config is build-time inlined, not request-time fetched.** No round-trip needed to render the user menu, format an integration URL, or pick an API base URL.
- **Env-var substitution gives us a single secret-passing mechanism** without forcing all of config into env vars: secrets live in `process.env`, everything else lives in YAML.

### Negative

- **Frontend config changes require a dev-server restart.** Because `client-config.ts` reads `NEXT_PUBLIC_*` literals that Next inlines at build/dev-start, changing `shipit.config.local.yaml` doesn't propagate until the next dev server boot. **Mitigation:** ADR-015 introduces a localStorage overlay for the dev-user block so the most-edited surface (the developer identity) updates without restart. Other frontend keys (integration subdomains) change rarely enough that restart cost is acceptable.
- **`next.config.mjs` duplicates the YAML loader and the env-substitution logic** (`loadShipitFrontendConfig`, `substituteEnv`). **Mitigation:** the duplicated code is small (~30 lines) and the reason is documented inline. The substitution syntax is intentionally a small subset of bash; divergence is unlikely as long as both stay simple. A future cleanup could move the loader to a tiny zero-dep package; not justified at current scope.
- **No runtime-mutable settings out of the box.** Anything that should change at runtime (feature flags, per-tenant overrides) has to go through a different mechanism (database, query string, cookie). **Mitigation:** This is by design — the config is the _deployment_ contract, not the _runtime_ contract.

### Neutral

- The web UI cannot import `@shipit-ai/shared` from `next.config.mjs` because turbo builds packages in parallel and `shared` may not be on disk yet. We accept the duplication rather than serializing the build graph.
- The Zod-typed `Config` is the _backend_ contract. The browser bundle uses a parallel TypeScript interface in `client-config.ts`. These have to be kept in sync by convention; the test surface to catch drift is `client-config` returning `null` on missing keys (which the consumers all handle).

## Alternatives Considered

### Alternative 1: Keep `.env` as the only config

- **Pros:** Zero additional tooling. Every dependency understands `.env` natively.
- **Cons:** Flat key namespace. No structured nesting (integrations, capabilities arrays). No type-checked shape. No clean "defaults vs personalization" split — `.env.example` and `.env` always drift. Browser-visible env vars are a fragile coupling (one rename and the bundle goes silently blank).
- **Why rejected:** The pain points listed in Context are exactly what we hit. `.env` survives only for secrets that have to be in `process.env` for SDK reasons.

### Alternative 2: A single config file with sections gated by `NODE_ENV`

- **Pros:** One file. Familiar pattern (e.g., `config/{development,production}.yaml`).
- **Cons:** Still no separation between "the app's contract" and "this developer's machine". Every contributor's git diff still includes their personal settings.
- **Why rejected:** Doesn't solve the actual problem — it just reshapes it.

### Alternative 3: A config service hit over HTTP at runtime

- **Pros:** Runtime mutability. Centralized control.
- **Cons:** Requires a service the dev environment doesn't have. Network round-trip for every render. Bootstrap problem (how does the config service itself get configured?).
- **Why rejected:** Massive overkill for local-dev configuration. Reserved for production tenant config later, behind its own ADR.

### Alternative 4: TOML or JSON instead of YAML

- **Pros:** Simpler grammar (TOML), easier parsing (JSON).
- **Cons:** No native comments in JSON (lose the example-file affordance). TOML's nested-table syntax is uglier than YAML for the integrations subtree. Engineering convention here is YAML for human-edited config files.
- **Why rejected:** YAML's comment support and nesting beat the parser-simplicity argument for a human-edited file.
