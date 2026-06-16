---
type: investigation
status: fixed
importance: core
created: 2026-06-15
updated: 2026-06-15
author: claude-session-2026-06-15
branch: more-prod-fixes
tags: [identity, person, canonical-id, github, connector, login, merge, bug]
---

# Login email never merges onto connector Person — uppercase-login canonical-ID mismatch

## Symptom

User's GitHub-connector-pulled Person did not merge with their logged-in
ShipIt Person, and never received the email from their login.

## Root cause (CONFIRMED — real bug)

Person merge is keyed solely on the canonical id
`shipit://person/default/<login>`. `buildCanonicalId()`
(`packages/shared/src/identity/canonical-id.ts`) lowercases only the
LABEL segment, NOT the name. The two producers disagree on casing:

- **Login upsert** (`api-server/src/services/person-upsert.ts`): keys by
  `identity.login.toLowerCase()` → `shipit://person/default/<lower>`.
  Carries the `email` + `name` claims (the only source of a member email).
- **GitHub connector** (`connectors/github/src/normalizers/team.ts:56`
  and `normalizers/codeowner.ts:28`): keys by `member.login` /
  `cleanOwner` RAW (GitHub's original case) → `shipit://person/default/<MixedCase>`.

The `IdentityReconciler` matches primary keys literally
(`linkingKeyIndex.hasCanonicalId(node.id)`, no case-folding), so any
uppercase letter in the login splits login-Person and connector-Person
into two nodes. The connector never carries an email (GitHub member APIs
don't expose member emails), so without the merge the connector Person
stays email-less forever.

`person-upsert.ts`'s own comment claims the two ids are "IDENTICAL" — the
assumption that broke. Lowercasing was added on the login side only.

## Proof

User's GitHub login is `Mohamed-E` (uppercase M, E):

- connector → `shipit://person/default/Mohamed-E`
- login → `shipit://person/default/mohamed-e`
  Distinct ids → no merge. Matches the reported symptom exactly.

## Also affected (same root cause)

- Intra-connector split: a `CODEOWNERS` entry `@mohamed-e` builds the
  lowercase id while team-membership builds `@Mohamed-E` → the SAME person
  becomes two nodes within the connector alone.

## Secondary (NOT this user's case, but related)

If the user signs into ShipIt via OIDC/Google, the login Person is keyed
by email (`shipit://person/default/<email>`), which by design never merges
with a github-login-keyed Person. Documented limitation in the login plan.

## Fix (implemented + verified locally, uncommitted on `more-prod-fixes`)

Single source of truth: new `buildPersonCanonicalId(loginOrEmail)` in
`packages/shared/src/identity/canonical-id.ts` (lowercases the key, then
`buildCanonicalId`). Used by BOTH sides so the casing can't drift again:

- connector `normalizers/team.ts` + `normalizers/codeowner.ts` (dropped the
  raw `buildCanonicalId('Person',…)`); `login` PROPERTY keeps original case.
- `api-server/src/services/person-upsert.ts` (login + email branches).

Re-sync cleanup: `runPersonLoginCaseMigration(client)` in
`core-writer/src/neo4j/migrations.ts`, wired into `main.ts` after the
canonical-id migration. Deletes Person nodes whose id name-segment has an
uppercase letter (regex `^shipit://person/default/.*[A-Z].*$`) + their
`_LinkingKey` / `_IdempotencyLog` entries, so the next sync's lowercase
Person merges with the login Person. Idempotent / unconditional (matches
zero rows once migrated), same pattern as `runCanonicalIdMigration`.

Tests (all green): shared `buildPersonCanonicalId` (`Mohamed-E`→lower);
connector normalizers (team + codeowner mixed-case → lowercase id, login
prop keeps case); migration regex unit tests; existing login-upsert
`GH-User`→`gh-user` already covered. Suites: shared 79, connector-github
30, core-writer 67, api-server 290. typecheck clean; prettier clean (no
eslint config on these backend packages).

Deploy note: takes effect on-cluster after merge → build → deploy AND a
fresh `core-writer` boot (runs the migration) + a connector `Sync now`
(regenerates lowercase Person). Relates to
[canonical-id-org-namespacing](../decisions/canonical-id-org-namespacing.md)
and [login-person-upsert-impl](../status/login-person-upsert-impl.md).
