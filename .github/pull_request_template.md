<!--
Thanks for sending a PR. Please:
  1. Keep the title short (under 70 chars). Use the body for details.
  2. Link the issue this PR closes — `Closes #N` will auto-close it on merge.
  3. Tick the checklist at the bottom before requesting review.
-->

## Summary

<!-- One paragraph: what changes and why. -->

## Type of change

<!-- Delete the rows that don't apply. Keep at least one. -->

- [ ] Bug fix (non-breaking, restores expected behavior)
- [ ] New feature (non-breaking, adds capability)
- [ ] Breaking change (changes API / config / on-wire format)
- [ ] Refactor (no functional change)
- [ ] Docs only
- [ ] Chore (deps, tooling, CI)

## Related issues

<!-- e.g. `Closes #123`, `Refs #456`, or "n/a". -->

## How was this tested?

<!--
Be specific. Examples:
  - `pnpm turbo test` — 14/14 green locally
  - Triggered a manual GitHub sync via /connectors UI, observed 29 entities in the graph explorer
  - Added unit tests in packages/<x>/src/__tests__/<y>.test.ts
-->

## Risk and rollout

<!--
Anything reviewers should know about blast radius:
  - Does this touch shared infra (event bus, Neo4j schema, BullMQ queue names)?
  - Does it require a config migration or a one-time data backfill?
  - Is there a rollback path other than `git revert`?
-->

## Screenshots / output

<!-- Optional. UI change? Drop a screenshot. CLI change? Paste before/after. -->

## Checklist

- [ ] `pnpm turbo typecheck` and `pnpm turbo test` both pass locally
- [ ] New code has tests (or I've justified why not in the PR description)
- [ ] Touched user-facing behavior is reflected in docs (`README.md`, `docs/`)
- [ ] If this PR makes a non-obvious architectural / dep / process decision, I've captured it under `docs/agent/` (decision, pattern, or scar)
- [ ] I've checked that no secrets, PEMs, or `.shipit.config.local.yaml` are staged
- [ ] If touching the GitHub connector, the event bus, or the Neo4j schema, I've read the relevant `docs/agent/decisions/*.md`
