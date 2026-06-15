const CANONICAL_ID_REGEX = /^shipit:\/\/([a-z-]+)\/([a-z0-9-]+)\/(.+)$/;

export function buildCanonicalId(label: string, namespace: string, name: string): string {
  const normalizedLabel = label.replace(/([A-Z])/g, (match, char, index) =>
    index > 0 ? `-${(char as string).toLowerCase()}` : (char as string).toLowerCase(),
  );
  return `shipit://${normalizedLabel}/${namespace}/${name}`;
}

export function buildScopedCanonicalId(
  label: string,
  namespace: string,
  scope: string,
  name: string,
): string {
  return buildCanonicalId(label, namespace, `${scope}/${name}`);
}

/**
 * Canonical id for a Person, keyed by GitHub login (or, for OIDC-only
 * logins, email). The key is LOWERCASED here — GitHub logins are
 * case-insensitive and globally unique, so two producers that disagree on
 * casing must still resolve to the same node. The GitHub connector emits
 * the login in GitHub's stored case (e.g. `Mohamed-E`) while the login
 * upsert keys off the same login; without a shared lowercasing rule the
 * two Person nodes never merge and the login's email never reaches the
 * connector-pulled Person. This helper is the single source of truth both
 * call so the casing can never drift again.
 *
 * `buildCanonicalId` only lowercases the LABEL segment, never the name —
 * so the key must be lowercased here.
 */
export function buildPersonCanonicalId(loginOrEmail: string): string {
  return buildCanonicalId('Person', 'default', loginOrEmail.toLowerCase());
}

export function parseCanonicalId(
  id: string,
): { label: string; namespace: string; name: string } | null {
  const match = id.match(CANONICAL_ID_REGEX);
  if (!match) return null;
  return {
    label: match[1],
    namespace: match[2],
    name: match[3],
  };
}

export function isValidCanonicalId(id: string): boolean {
  return CANONICAL_ID_REGEX.test(id);
}
