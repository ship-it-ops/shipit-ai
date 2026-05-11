const CANONICAL_ID_REGEX = /^shipit:\/\/([a-z-]+)\/([a-z0-9-]+)\/(.+)$/;

export function buildCanonicalId(label: string, namespace: string, name: string): string {
  const normalizedLabel = label.replace(/([A-Z])/g, (match, char, index) =>
    index > 0 ? `-${(char as string).toLowerCase()}` : (char as string).toLowerCase(),
  );
  return `shipit://${normalizedLabel}/${namespace}/${name}`;
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
