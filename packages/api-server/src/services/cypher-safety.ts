// Tokens that perform writes or transaction control. A substring scan would
// reject `MATCH (n {name:'CreateAccount'})` because "Create" appears inside a
// string literal — so we strip comments + string literals first, then look for
// the keywords as whole tokens (case-insensitive).
// Order matters: more specific/contextual keywords (DETACH, FOREACH) come
// before keywords they commonly appear with (DELETE, SET) so the surfaced
// keyword in the error message is the most informative one.
const WRITE_KEYWORDS = [
  'DETACH',
  'FOREACH',
  'CREATE',
  'MERGE',
  'DELETE',
  'SET',
  'REMOVE',
  'DROP',
  'LOAD',
] as const;

// `CALL` itself is allowed (db.labels, db.relationshipTypes, apoc.path.* are
// read-only), but a handful of CALL forms can mutate or escalate.
const DANGEROUS_CALL_PATTERNS = [
  /\bCALL\s+\{[\s\S]*?\}\s+IN\s+TRANSACTIONS\b/i,
  /\bCALL\s+apoc\.periodic\./i,
  /\bCALL\s+apoc\.refactor\./i,
  /\bCALL\s+apoc\.create\./i,
  /\bCALL\s+apoc\.merge\./i,
  /\bCALL\s+apoc\.cypher\.(run|doIt)\b/i,
  /\bCALL\s+db\.create/i,
];

function stripCommentsAndStrings(cypher: string): string {
  let out = '';
  let i = 0;
  while (i < cypher.length) {
    const ch = cypher[i];
    const next = cypher[i + 1];

    // Line comments: // … \n
    if (ch === '/' && next === '/') {
      while (i < cypher.length && cypher[i] !== '\n') i++;
      continue;
    }
    // Block comments: /* … */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < cypher.length - 1 && !(cypher[i] === '*' && cypher[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Single- and double-quoted strings
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ' ';
      i++;
      while (i < cypher.length && cypher[i] !== quote) {
        if (cypher[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    // Backtick identifiers (e.g., `My-Label-Create`) — content is an identifier,
    // never a keyword. Blank out the body so labels like `Create-Foo` don't
    // trigger the keyword scan.
    if (ch === '`') {
      out += ' ';
      i++;
      while (i < cypher.length && cypher[i] !== '`') i++;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export interface CypherSafetyResult {
  safe: boolean;
  reason?: string;
  keyword?: string;
}

export function checkCypherSafety(cypher: string): CypherSafetyResult {
  const trimmed = cypher.trim();
  if (!trimmed) {
    return { safe: false, reason: 'Query is empty' };
  }
  const stripped = stripCommentsAndStrings(trimmed);

  for (const keyword of WRITE_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`, 'i');
    if (re.test(stripped)) {
      return {
        safe: false,
        reason: `Write keyword "${keyword}" is not allowed in the Query Playground (read-only).`,
        keyword,
      };
    }
  }

  for (const pattern of DANGEROUS_CALL_PATTERNS) {
    if (pattern.test(stripped)) {
      return {
        safe: false,
        reason: 'This procedure can mutate the graph and is blocked in the Query Playground.',
        keyword: 'CALL',
      };
    }
  }

  return { safe: true };
}
