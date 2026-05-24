// Neo4j-backed LinkingKeyIndex. Production swap for the
// InMemoryLinkingKeyIndex used in tests. Stores linking keys as
// `_LinkingKey` nodes (already created by `registerLinkingKey` in
// queries.ts) and uses primary-key presence in the graph to answer
// `hasCanonicalId`.
import type { LinkingKeyIndex } from '../identity/linking-key-index.js';
import { Neo4jClient } from './client.js';
import { lookupLinkingKey, registerLinkingKey } from './queries.js';

export class Neo4jLinkingKeyIndex implements LinkingKeyIndex {
  private readonly client: Neo4jClient;
  private readonly database?: string;

  constructor(client: Neo4jClient, database?: string) {
    this.client = client;
    this.database = database;
  }

  async lookupByLinkingKey(linkingKey: string): Promise<string | null> {
    if (!linkingKey) return null;
    return this.client.executeRead(async (tx) => {
      return lookupLinkingKey(tx, linkingKey);
    }, this.database);
  }

  // Looks for any labelled node with the given `id`. The reconciler uses
  // this to short-circuit when a canonical ID is already present in the
  // graph — we don't care about its label, only existence.
  async hasCanonicalId(canonicalId: string): Promise<boolean> {
    return this.client.executeRead(async (tx) => {
      const result = await tx.run(`MATCH (n {id: $id}) RETURN n.id AS id LIMIT 1`, {
        id: canonicalId,
      });
      return result.records.length > 0;
    }, this.database);
  }

  async register(canonicalId: string, linkingKey: string): Promise<void> {
    if (!linkingKey) return; // Nothing to index by; the node will still be created.
    await this.client.executeWrite(async (tx) => {
      await registerLinkingKey(tx, canonicalId, linkingKey);
    }, this.database);
  }

  // Alias both keys to the same canonical ID. registerLinkingKey is upsert
  // semantics, so re-registering oldLinkingKey is safe if it already exists.
  async registerAlias(
    canonicalId: string,
    oldLinkingKey: string,
    newLinkingKey: string,
  ): Promise<void> {
    await this.client.executeWrite(async (tx) => {
      if (oldLinkingKey) await registerLinkingKey(tx, canonicalId, oldLinkingKey);
      if (newLinkingKey) await registerLinkingKey(tx, canonicalId, newLinkingKey);
    }, this.database);
  }
}
