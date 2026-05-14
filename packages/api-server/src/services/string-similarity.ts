// Phase 2: string-similarity helpers for fuzzy entity matching.
// Vector embeddings + ANN are deferred to a later mini-phase — until then we
// use lexical similarity (Jaro-Winkler + trigram Jaccard) per design doc §5.3.

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Jaro distance: classic string similarity for short identifiers like names. */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches: boolean[] = new Array(a.length).fill(false);
  const bMatches: boolean[] = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
}

/** Jaro-Winkler: rewards shared prefixes. Threshold 0.7 prevents inflation for poor matches. */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const na = normalize(a);
  const nb = normalize(b);
  const score = jaro(na, nb);
  if (score < 0.7) return score;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, na.length, nb.length); i++) {
    if (na[i] === nb[i]) prefix++;
    else break;
  }
  return score + prefix * prefixScale * (1 - score);
}

function trigrams(s: string): Set<string> {
  const padded = `  ${normalize(s)}  `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Jaccard similarity over character trigrams. Best for tag sets / multi-token strings. */
export function trigramJaccard(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const ga = trigrams(a);
  const gb = trigrams(b);
  let inter = 0;
  for (const t of ga) if (gb.has(t)) inter++;
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Compare two arrays of strings (e.g., tags / labels) as a multi-set Jaccard. */
export function setSimilarity(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a.map(normalize));
  const sb = new Set(b.map(normalize));
  let inter = 0;
  for (const v of sa) if (sb.has(v)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}
