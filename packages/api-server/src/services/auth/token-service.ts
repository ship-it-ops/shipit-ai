import { randomBytes } from 'node:crypto';
import { formatToken, hashSecret, constantTimeEqual, splitToken } from '@shipit-ai/shared';
import type { Neo4jService } from '../neo4j-service.js';

// MCP/personal-access tokens. Each token is split into a public id and a
// secret on issue; we store the id in the clear (so lookup is O(1)) and
// only a salted SHA-256 of the secret. On validate we parse the id out of
// the plaintext, fetch the row, hash the supplied secret with the stored
// salt, and compare with constant-time equality.
//
// This is the same approach used by GitHub (ghp_*), Vercel, Stripe, etc.
// It defeats database-leak attacks (no plaintext to replay), supports
// fast lookup, and lets `lastUsedAt` updates be issued as a separate
// non-critical write.
//
// Storage lives on Neo4j `_AccessToken` nodes — the underscore prefix
// matches the existing internal-node-label-underscore-prefix pattern so
// they're transparently excluded from searchEntities / graph overview /
// the catalog.

// Token parse/hash/compare primitives live in @shipit-ai/shared so the
// mcp-server validates against the same implementation. These byte sizes are
// generation-only (minting happens here, not in the mcp-server).
const TOKEN_ID_BYTES = 9; // 9 raw bytes → 12 base64url chars
const TOKEN_SECRET_BYTES = 32; // 32 raw bytes → 43 base64url chars
const SALT_BYTES = 16;

export interface AccessTokenMetadata {
  id: string;
  name: string;
  ownerEmail: string;
  scopes: ReadonlyArray<string>;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export interface AccessTokenWithPlaintext extends AccessTokenMetadata {
  /** Returned exactly once at creation time and never persisted. */
  plaintext: string;
}

export interface ValidatedToken {
  id: string;
  ownerEmail: string;
  scopes: ReadonlyArray<string>;
}

export interface TokenServiceOptions {
  neo4j: Neo4jService;
  /** Override the clock for tests. */
  now?: () => Date;
}

export class TokenService {
  private readonly neo4j: Neo4jService;
  private readonly now: () => Date;

  constructor(opts: TokenServiceOptions) {
    this.neo4j = opts.neo4j;
    this.now = opts.now ?? (() => new Date());
  }

  async create(args: {
    name: string;
    ownerEmail: string;
    scopes: ReadonlyArray<string>;
  }): Promise<AccessTokenWithPlaintext> {
    const id = randomBytes(TOKEN_ID_BYTES).toString('base64url');
    const secret = randomBytes(TOKEN_SECRET_BYTES).toString('base64url');
    const salt = randomBytes(SALT_BYTES).toString('base64url');
    const tokenHash = hashSecret(secret, salt);
    const plaintext = formatToken(id, secret);
    const createdAt = this.now().toISOString();

    await this.neo4j.runQuery(
      `CREATE (t:_AccessToken {
         id: $id,
         name: $name,
         tokenHash: $tokenHash,
         salt: $salt,
         ownerEmail: $ownerEmail,
         scopes: $scopes,
         createdAt: $createdAt,
         lastUsedAt: null,
         revoked: false
       })`,
      {
        id,
        name: args.name,
        tokenHash,
        salt,
        ownerEmail: args.ownerEmail.toLowerCase(),
        scopes: [...args.scopes],
        createdAt,
      },
    );

    return {
      id,
      name: args.name,
      ownerEmail: args.ownerEmail.toLowerCase(),
      scopes: args.scopes,
      createdAt,
      lastUsedAt: null,
      revoked: false,
      plaintext,
    };
  }

  async listForOwner(ownerEmail: string): Promise<ReadonlyArray<AccessTokenMetadata>> {
    const records = await this.neo4j.runQuery(
      `MATCH (t:_AccessToken { ownerEmail: $ownerEmail })
       RETURN t
       ORDER BY t.createdAt DESC`,
      { ownerEmail: ownerEmail.toLowerCase() },
    );
    return records.map((r) => {
      const props = (r.get('t') as { properties: Record<string, unknown> }).properties;
      return rowToMetadata(props);
    });
  }

  /**
   * Revoke a token by id. Only the original owner can revoke — passing
   * the email defends against the cross-user-revoke route bug.
   *
   * Returns `true` when a matching token was found AND newly revoked,
   * `false` when no match existed for that owner (so the caller can
   * return 404 instead of pretending success).
   */
  async revoke(id: string, ownerEmail: string): Promise<boolean> {
    const records = await this.neo4j.runQuery(
      `MATCH (t:_AccessToken { id: $id, ownerEmail: $ownerEmail })
       SET t.revoked = true
       RETURN t.id AS id`,
      { id, ownerEmail: ownerEmail.toLowerCase() },
    );
    return records.length > 0;
  }

  /**
   * Validate a Bearer token plaintext. Returns the principal-shaped
   * descriptor on success; null on any failure (malformed, unknown id,
   * wrong secret, revoked). The caller turns null into a 401.
   *
   * Fires off a best-effort `lastUsedAt` write but doesn't await it — the
   * field is observability-only and a slow Neo4j shouldn't slow down
   * every API call.
   */
  async validate(plaintext: string): Promise<ValidatedToken | null> {
    const parts = splitToken(plaintext);
    if (!parts) return null;

    const records = await this.neo4j.runQuery(
      `MATCH (t:_AccessToken { id: $id })
       RETURN t`,
      { id: parts.id },
    );
    if (records.length === 0) return null;

    const props = (records[0]!.get('t') as { properties: Record<string, unknown> }).properties;
    if (props.revoked === true) return null;

    const expectedHash = typeof props.tokenHash === 'string' ? props.tokenHash : '';
    const salt = typeof props.salt === 'string' ? props.salt : '';
    const computed = hashSecret(parts.secret, salt);
    if (!constantTimeEqual(computed, expectedHash)) return null;

    void this.touchLastUsed(parts.id);

    return {
      id: parts.id,
      ownerEmail: String(props.ownerEmail ?? ''),
      scopes: Array.isArray(props.scopes) ? (props.scopes as string[]) : [],
    };
  }

  private async touchLastUsed(id: string): Promise<void> {
    try {
      await this.neo4j.runQuery(`MATCH (t:_AccessToken { id: $id }) SET t.lastUsedAt = $ts`, {
        id,
        ts: this.now().toISOString(),
      });
    } catch {
      // Swallow — observability fields aren't worth failing a request over.
    }
  }
}

function rowToMetadata(props: Record<string, unknown>): AccessTokenMetadata {
  return {
    id: String(props.id ?? ''),
    name: String(props.name ?? ''),
    ownerEmail: String(props.ownerEmail ?? ''),
    scopes: Array.isArray(props.scopes) ? (props.scopes as string[]) : [],
    createdAt: String(props.createdAt ?? ''),
    lastUsedAt: typeof props.lastUsedAt === 'string' ? props.lastUsedAt : null,
    revoked: props.revoked === true,
  };
}
