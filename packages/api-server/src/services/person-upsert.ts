// Builds a Person CanonicalEntity from an authenticated login so the
// signed-in user appears in the knowledge graph. Pure + side-effect free:
// the route handler (routes/auth.ts) publishes the result on the event bus,
// and the core-writer reconciles it through the same path the GitHub
// connector uses.
//
// The single load-bearing constraint is the canonical id. Both this path and
// the connector build it via the shared `buildPersonCanonicalId(login)`,
// which lowercases the login — so a GitHub login with uppercase
// (`Mohamed-E`) produces the IDENTICAL id on both sides (see
// connectors/github/src/normalizers/team.ts) and the IdentityReconciler
// matches on the primary key and MERGES the two rather than creating a
// duplicate. (Earlier this side lowercased but the connector did not, so
// uppercase logins never merged — see
// docs/agent/investigations/person-canonical-id-login-case-mismatch.md.)
// Login-sourced claims fill the gaps the connector lacks (`name`, `email`)
// while overlapping claims (`login`) stay below the connector's confidence so
// the connector keeps winning them.
import type { CanonicalEntity, CanonicalNode, PropertyClaim } from '@shipit-ai/shared';
import { buildPersonCanonicalId, buildLinkingKey } from '@shipit-ai/shared';

// Below the connector's 0.9 so overlapping claims (login) resolve to the
// connector under the default HIGHEST_CONFIDENCE strategy; name/email are
// login-only, so they win by being the sole claim regardless.
const LOGIN_CLAIM_CONFIDENCE = 0.85;

export interface LoginIdentity {
  provider: 'github' | 'oidc';
  /** Stable IdP subject — numeric GitHub user id or OIDC `sub`. */
  sub: string;
  /** Human display name; for GitHub this already falls back to the login. */
  displayName: string;
  email: string;
  /**
   * GitHub username. Present for GitHub logins (the merge key); absent for
   * OIDC, which carries no GitHub identity and therefore keys by email.
   */
  login?: string;
}

function makeClaim(key: string, value: unknown, sourceId: string, now: string): PropertyClaim {
  return {
    property_key: key,
    value,
    source: 'login',
    source_id: sourceId,
    ingested_at: now,
    confidence: LOGIN_CLAIM_CONFIDENCE,
    evidence: null,
  };
}

/**
 * Build the Person entity for a completed login. `now` is injectable for
 * deterministic tests.
 */
export function buildLoginPersonEntity(
  identity: LoginIdentity,
  now: Date = new Date(),
): CanonicalEntity {
  const iso = now.toISOString();
  // Coarse `_event_version` (date bucket) — the producer folds it into the
  // idempotency key (`<connector>~<id>~<version>`), so repeated logins on the
  // same day dedupe instead of writing on every callback. `_event_version`
  // is only ever used for that key (never compared numerically), so a date
  // string coexists safely with the connector's integer version.
  const eventVersion = iso.slice(0, 10); // YYYY-MM-DD

  // GitHub → login-keyed (merges with the connector Person). OIDC → email-keyed
  // (best-effort; will NOT merge with a GitHub-connector Person — documented
  // limitation, fine for OIDC-only deployments). buildPersonCanonicalId
  // lowercases the key — the SAME helper the connector uses, so a GitHub
  // login with uppercase (`Mohamed-E`) resolves to the identical id on both
  // sides and the two Person nodes merge.
  const mergeKey =
    identity.provider === 'github' && identity.login ? identity.login : identity.email;
  const id = buildPersonCanonicalId(mergeKey);

  // Linking key for THIS idp identity. Distinct from the connector's
  // `github://<org>/user/<login>`; the canonical id above is the strong merge
  // key, this is only a secondary index entry.
  const sourceId = buildLinkingKey('identity', identity.provider, identity.sub);

  const properties: Record<string, unknown> = {
    name: identity.displayName,
    email: identity.email,
  };
  const claims: PropertyClaim[] = [
    makeClaim('name', identity.displayName, sourceId, iso),
    makeClaim('email', identity.email, sourceId, iso),
  ];
  if (identity.login) {
    properties.login = identity.login;
    claims.push(makeClaim('login', identity.login, sourceId, iso));
  }

  const node: CanonicalNode = {
    id,
    label: 'Person',
    properties,
    _claims: claims,
    _source_system: 'login',
    _source_org: 'login',
    _source_id: sourceId,
    _last_synced: iso,
    _event_version: eventVersion,
  };

  // No edges — the GitHub connector owns team-membership relations.
  return { nodes: [node], edges: [] };
}
