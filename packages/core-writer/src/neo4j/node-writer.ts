// Neo4j-backed NodeWriter — drains the CoreWriter abstraction onto the
// graph. Each call opens a managed-write transaction so node + edge writes
// are atomic per call; batching of multiple nodes per transaction lives one
// level up in BatchProcessor.
import type { CanonicalEdge, CanonicalNode, PropertyClaim } from '@shipit-ai/shared';
import type { NodeWriter, WriteNodeResult } from '../writer.js';
import { Neo4jClient } from './client.js';
import {
  getExistingClaims,
  mergeEdge,
  mergeNode,
  touchLastSynced,
  type ExistingClaims,
} from './queries.js';

export class Neo4jNodeWriter implements NodeWriter {
  private readonly client: Neo4jClient;
  private readonly database?: string;

  constructor(client: Neo4jClient, database?: string) {
    this.client = client;
    this.database = database;
  }

  async writeNode(
    node: CanonicalNode,
    mergedClaims: PropertyClaim[],
    effectiveProperties: Record<string, unknown>,
    expectedClaimsRev = 0,
  ): Promise<WriteNodeResult> {
    return this.client.executeWrite(async (tx) => {
      return mergeNode(tx, node, mergedClaims, effectiveProperties, expectedClaimsRev);
    }, this.database);
  }

  async writeEdge(edge: CanonicalEdge): Promise<void> {
    await this.client.executeWrite(async (tx) => {
      await mergeEdge(tx, edge);
    }, this.database);
  }

  async getExistingClaims(nodeId: string): Promise<ExistingClaims> {
    return this.client.executeRead(async (tx) => {
      return getExistingClaims(tx, nodeId);
    }, this.database);
  }

  async touchLastSynced(nodeId: string, lastSynced: string): Promise<void> {
    await this.client.executeWrite(async (tx) => {
      await touchLastSynced(tx, nodeId, lastSynced);
    }, this.database);
  }
}
