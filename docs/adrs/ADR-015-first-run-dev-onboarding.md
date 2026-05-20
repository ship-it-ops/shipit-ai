# ADR-015: First-Run Dev Onboarding Lives in the Web UI

## Status

Accepted

## Date

2026-05-20

## Context

Before this change, first-time onboarding ran in `scripts/preflight.sh`. The script printed an interactive `read` prompt during `pnpm start:frontend` (or `start:all`) and `awk`-patched the resulting `firstName`/`lastName`/`email` into `shipit.config.local.yaml`. That worked, but the surface had three concrete problems:

1. **Non-TTY shells silently skip the prompt.** IDE-integrated terminals, the Next dev script that auto-opens a browser, and CI all run without an attached TTY. The prompt's `[ ! -t 0 ]` branch printed a one-line hint and moved on, leaving every fresh checkout with the placeholder identity "Dev User dev@shipit.local" everywhere in the UI. New contributors didn't notice they'd missed setup until they saw their fake name in the user menu.
2. **It only collected 3 of the 7 `frontend.devUser` fields.** `role`, `team`, `joinedAt`, `capabilities` were hand-edit-only. The profile page rendered half-defaulted by default.
3. **It looked like an auth bug.** Nothing in the UI signaled "this is local-only mock identity until real auth lands." Users assumed the app was broken.

A second, related surface had the same TTY-skip problem: `scripts/maybe-seed.sh` prompted "Seed the Acme Pay sample dataset? [Y/n]" — same silent skip path on non-TTY, same "user wonders why nothing is here" outcome.

We want both decisions (dev identity, demo data) collected in one place, with a clear signal that this is local-dev mock setup, persistence to the gitignored `shipit.config.local.yaml` introduced in ADR-014, and graceful behavior when the write fails.

## Decision

First-run onboarding is a multi-step wizard modal mounted in the running web UI. Concretely:

- **Detection.** `<OnboardingTrigger />` (in `packages/web-ui/src/components/onboarding/onboarding-trigger.tsx`) is mounted globally inside `<Providers>` in `app/layout.tsx`. On mount it opens the wizard iff (a) `process.env.NODE_ENV !== 'production'`, (b) `clientConfig.devUser` matches the example verbatim (`firstName === 'Dev' && lastName === 'User' && email === 'dev@shipit.local'`), and (c) `localStorage.getItem('shipit:onboarding-complete') !== 'true'`. The verbatim-default check matches the same heuristic the old preflight script used.
- **The wizard.** Four steps — Identity, Profile (role/team/joinedAt + capabilities checkboxes), Seed (demo-data consent), Review — built on `@ship-it-ui/ui`'s `WizardDialog`. A `Banner tone="accent"` on the first step makes the local-dev framing explicit ("Real auth isn't wired up yet…"). The seed step auto-skips when Neo4j is unreachable or the graph already has data.
- **Server-side write.** A Next.js Route Handler at `packages/web-ui/src/app/api/onboarding/dev-user/route.ts` (Node runtime) accepts the validated payload, locates `shipit.config.local.yaml` via the same `findConfigPaths` helper used elsewhere, reads it with `yaml`'s `parseDocument()` (so comments survive the round-trip), `setIn`s each devUser field, and atomically writes via tempfile + `rename`. A sibling `seed/route.ts` exposes `GET` (probes `has-graph-data.ts` exit codes) and `POST` (spawns `pnpm seed` with a 60s cap, returning the stderr tail on failure).
- **Production gate.** Both route handlers `return NextResponse.json(..., { status: 403 })` if `NODE_ENV === 'production'`. The onboarding components are mounted unconditionally, but `OnboardingTrigger` also short-circuits on `NODE_ENV === 'production'` before opening. There is no path to mutate config from the running web server in a deployed build.
- **Restart-free UX via localStorage overlay.** Because `next.config.mjs` bakes the YAML into `NEXT_PUBLIC_SHIPIT_*` env vars at dev-server start (ADR-014), a new write to `shipit.config.local.yaml` doesn't propagate into `clientConfig` without a Next restart. To bridge the gap, the dialog also writes the saved value to `localStorage['shipit:dev-user-override']` and dispatches a `shipit:dev-user-changed` event. `useCurrentUser()` (`packages/web-ui/src/lib/current-user.ts`) reads via `useSyncExternalStore`, overlaying the localStorage value on top of `clientConfig.devUser`. The UI updates immediately; the YAML is the source of truth on the next dev-server boot.
- **Failure path is informative.** If the route handler can't write (read-only file, ENOSPC, missing config), it returns `{ ok: false, code, message, manualYaml }` where `manualYaml` is a ready-to-paste YAML snippet. The dialog renders that snippet in a copyable code block and a "I've pasted it" dismissal that still flips `onboarding-complete` so the user isn't nagged.
- **Shell scripts are stripped of their interactive prompts.** `scripts/preflight.sh` keeps the example-file bootstrap and emits a one-line "personalize from the in-app modal" hint. `scripts/maybe-seed.sh` keeps the graph-empty probe and emits a hint pointing at the modal. Neither runs an interactive `read` anymore.

## Consequences

### Positive

- **Single, visible onboarding surface.** Users see a real modal in their browser instead of a hidden prompt in their terminal. The "this is local/dev" framing is in their face, not buried in shell output.
- **All seven `devUser` fields are now collected, including capabilities checkboxes.** The profile page is fully populated on first login.
- **Non-TTY footgun eliminated.** The trigger fires on browser open, which works regardless of how the dev server was started (IDE terminal, auto-opened browser, CI replay).
- **Production cannot accidentally write config.** The route handler 403s, and the trigger short-circuits before the user could even see the modal.
- **Graceful degradation.** Write failures don't deadlock the user — they get the exact snippet to paste manually, and the dialog stops nagging.
- **Demo-data consent moves to the same surface.** Users no longer get two TTY prompts (identity + seed); both consents live in the same wizard with a status-aware seed step.

### Negative

- **A new Next.js Route Handler creates a new architectural seam.** Until now, the web UI proxied to Fastify for all server logic; the route handlers in `packages/web-ui/src/app/api/onboarding/*` are the first Node-runtime endpoints owned by the web UI. **Mitigation:** They are explicitly scoped to dev-only filesystem operations and are 403-gated in production. The Fastify api-server remains the canonical server for everything else.
- **localStorage overlay introduces a source-of-truth split.** During a dev session, the YAML and `localStorage` can disagree (e.g., if the user manually edits the YAML mid-session). **Mitigation:** Documented in `current-user.ts` and `client-config.ts`. The overlay wins for the duration of the session; the YAML wins on every dev-server restart. The drift window is intentional — it's what makes the no-restart UX work.
- **The wizard is `WizardDialog`-coupled.** If the design system changes the wizard API, the onboarding flow updates with it. **Mitigation:** This is intentional per ADR-013; we live with library coupling everywhere.
- **The trigger calls `setState` inside a one-shot effect** (a soft anti-pattern flagged by the React-hooks ESLint rule). **Mitigation:** Other browser-only-decision sites in the codebase (`use-recently-viewed.ts`, `entity-search-box.tsx`) use the same pattern. SSR can't read localStorage; the effect-then-setState shape is the canonical Next.js workaround.

### Neutral

- The cancel button is labeled "Don't show again" rather than "Skip for now" because cancelling sets `onboarding-complete=true`. Cleanup with the user-visible label honest about the side effect; reopening requires clearing the localStorage key.

## Alternatives Considered

### Alternative 1: Keep the CLI prompt; improve it

- **Pros:** Stays out of the runtime path. No new server endpoint. No bundler coupling.
- **Cons:** Doesn't fix the non-TTY footgun, which is the load-bearing problem. Improving the CLI prompt (better defaults, more fields, non-TTY auto-detect) only addresses the symptoms.
- **Why rejected:** The non-TTY skip is the _original_ reason new contributors didn't notice they'd missed setup. Anything that runs at terminal-startup time has this problem.

### Alternative 2: Have the Fastify api-server write the YAML

- **Pros:** Keeps all server-side filesystem work in one process.
- **Cons:** `start:frontend` doesn't run the api-server. The modal needs to work in that flow. CORS surface, layering complexity. The api-server doesn't know where `shipit.config.local.yaml` lives in deployed environments (and shouldn't).
- **Why rejected:** The work is dev-only and the web UI's dev server already reads the same file (`next.config.mjs`). Putting writes in the same process is symmetric and minimizes coupling.

### Alternative 3: localStorage only — don't write to disk at all

- **Pros:** Simplest. No server-side endpoint.
- **Cons:** Doesn't survive `git stash` / branch switches / fresh checkouts. Users would re-onboard constantly.
- **Why rejected:** The whole point of the YAML is _persistence_.

### Alternative 4: Disk only — no localStorage overlay; require a dev-server restart after save

- **Pros:** Single source of truth. No drift window.
- **Cons:** Save → "restart your dev server" → blank UI for ~15s → back to the modal still showing because env vars haven't reloaded — terrible UX.
- **Why rejected:** The localStorage overlay is what makes the save feel instantaneous; the cost (a momentary YAML/localStorage drift) is documented and small.
