// Personal-access / MCP token crypto primitives, shared between the
// api-server (which mints + validates tokens) and the mcp-server (which
// validates a bearer token against the same Neo4j `_AccessToken` store).
//
// A token is `shipit_pat_<id>.<secret>`: the id is stored in the clear (O(1)
// lookup) and only a salted SHA-256 of the secret is persisted. Validation
// parses the id, fetches the row, hashes the supplied secret with the stored
// salt, and compares in constant time. Keeping these primitives in ONE place
// means the security-critical hashing/compare has a single implementation
// both servers share.

import { createHash, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIX = 'shipit_pat_';
// `.` separates the id from the secret. Both halves are base64url (which can
// include `_` and `-`), so `.` is the only ASCII separator safe to use
// without escaping the random bytes.
export const TOKEN_SEPARATOR = '.';

/**
 * Parse the `<id>.<secret>` payload from a `shipit_pat_<id>.<secret>` token.
 * Returns null on any malformed input so the validate path can collapse
 * "wrong prefix", "wrong shape", and "wrong content" into one "invalid"
 * branch.
 */
export function splitToken(plaintext: string): { id: string; secret: string } | null {
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
  const rest = plaintext.slice(TOKEN_PREFIX.length);
  const sep = rest.indexOf(TOKEN_SEPARATOR);
  if (sep <= 0 || sep === rest.length - 1) return null;
  const id = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  return { id, secret };
}

/** Salted SHA-256 of the secret, hex. The salt is a per-row random value. */
export function hashSecret(secret: string, salt: string): string {
  return createHash('sha256').update(`${salt}.${secret}`).digest('hex');
}

/**
 * Constant-time string compare. Both inputs here are SHA-256 hex digests
 * (always 64 chars); a length mismatch means malformed input rather than a
 * timing oracle a real token could exploit, and timingSafeEqual requires
 * equal-length buffers, so the early return satisfies its precondition.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const buf = Buffer.from(a);
  const other = Buffer.from(b);
  if (buf.length !== other.length) return false;
  return timingSafeEqual(buf, other);
}

/** Format a token from its id + secret halves. */
export function formatToken(id: string, secret: string): string {
  return `${TOKEN_PREFIX}${id}${TOKEN_SEPARATOR}${secret}`;
}
