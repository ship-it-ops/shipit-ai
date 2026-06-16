import type {
  CanonicalNode,
  CanonicalEdge,
  EventEnvelope,
  EventBusClient,
} from '@shipit-ai/shared';
import { ClaimResolver } from './claims/resolver.js';
import { IdentityReconciler } from './identity/reconciler.js';
import type { LinkingKeyIndex } from './identity/linking-key-index.js';
import { buildNodeIdempotencyKey, type IdempotencyChecker } from './idempotency.js';
import { BatchProcessor } from './batch.js';
import type { CoreWriterConfig } from './config.js';

export interface WriteResult {
  nodesWritten: number;
  edgesWritten: number;
  duplicatesSkipped: number;
  errors: string[];
}

export interface NodeWriter {
  writeNode(
    node: CanonicalNode,
    mergedClaims: CanonicalNode['_claims'],
    effectiveProperties: Record<string, unknown>,
  ): Promise<void>;
  writeEdge(edge: CanonicalEdge): Promise<void>;
  getExistingClaims(nodeId: string): Promise<CanonicalNode['_claims']>;
  /**
   * Refresh only a node's `_last_synced` timestamp without touching claims or
   * properties. Used when an idempotent re-sync confirms an unchanged entity:
   * the content write is skipped, but "last synced" should still advance.
   */
  touchLastSynced(nodeId: string, lastSynced: string): Promise<void>;
}

export class CoreWriter {
  private readonly resolver: ClaimResolver;
  private readonly reconciler: IdentityReconciler;
  private readonly idempotency: IdempotencyChecker;
  private readonly nodeWriter: NodeWriter;
  private readonly batchProcessor: BatchProcessor;
  private readonly config: CoreWriterConfig;

  constructor(
    nodeWriter: NodeWriter,
    linkingKeyIndex: LinkingKeyIndex,
    idempotency: IdempotencyChecker,
    config: CoreWriterConfig,
  ) {
    this.nodeWriter = nodeWriter;
    this.resolver = new ClaimResolver({
      decayRate: config.defaultDecayRate,
    });
    this.reconciler = new IdentityReconciler(linkingKeyIndex);
    this.idempotency = idempotency;
    this.config = config;
    this.batchProcessor = new BatchProcessor(
      async (batch) => {
        await this.processBatch(batch);
      },
      { batchSize: config.batchSize },
    );
  }

  async start(eventBus: EventBusClient): Promise<void> {
    this.batchProcessor.start();
    await eventBus.subscribe(async (event: EventEnvelope) => {
      await this.batchProcessor.add(event);
    });
  }

  async stop(): Promise<void> {
    await this.batchProcessor.stop();
  }

  async processEvent(event: EventEnvelope): Promise<WriteResult> {
    return this.processBatch([event]);
  }

  async processBatch(batch: EventEnvelope[]): Promise<WriteResult> {
    let nodesWritten = 0;
    let edgesWritten = 0;
    let duplicatesSkipped = 0;
    const errors: string[] = [];

    for (const event of batch) {
      const { payload } = event;
      if (!payload || !Array.isArray(payload.nodes)) continue;

      // Process nodes
      for (const node of payload.nodes) {
        try {
          const idempotencyKey = buildNodeIdempotencyKey(event.connector_id, node);

          // Reconcile first so we know the canonical id even on the skip path.
          const reconciliation = await this.reconciler.reconcile(node);

          // Check idempotency
          if (await this.idempotency.isDuplicate(idempotencyKey)) {
            duplicatesSkipped++;
            // Unchanged entity, but the connector re-confirmed it this run.
            // Refresh only the freshness timestamp (cheap single-property write,
            // no claim re-resolution) so the catalog "Synced" tracks the latest
            // run and staleness reflects connector health, not content churn.
            // Best effort — a touch failure must not fail the sync.
            if (typeof node._last_synced === 'string') {
              try {
                await this.nodeWriter.touchLastSynced(
                  reconciliation.canonicalId,
                  node._last_synced,
                );
              } catch {
                // non-critical: timestamp refresh failed, leave it stale
              }
            }
            continue;
          }

          // Get existing claims from the graph
          const existingClaims = await this.nodeWriter.getExistingClaims(
            reconciliation.canonicalId,
          );

          // Resolve claims
          const { mergedClaims, effectiveProperties } = this.resolver.resolve(
            existingClaims,
            node._claims,
          );

          // Write node with resolved claims and effective properties
          const nodeToWrite: CanonicalNode = {
            ...node,
            id: reconciliation.canonicalId,
          };
          await this.nodeWriter.writeNode(nodeToWrite, mergedClaims, effectiveProperties);

          // Record idempotency
          await this.idempotency.record(idempotencyKey);
          nodesWritten++;
        } catch (err) {
          errors.push(
            `Error writing node ${node.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Process edges
      if (!Array.isArray(payload.edges)) continue;
      for (const edge of payload.edges) {
        try {
          await this.nodeWriter.writeEdge(edge);
          edgesWritten++;
        } catch (err) {
          errors.push(
            `Error writing edge ${edge.type} ${edge.from}->${edge.to}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Per-node errors are caught inside the loop above. Surface them so write
    // failures don't disappear silently — `processBatch` returns the count
    // but nothing else logs the actual reasons.
    if (errors.length > 0) {
      for (const e of errors.slice(0, 5)) console.error('[CoreWriter]', e);
      if (errors.length > 5) console.error(`[CoreWriter] (+${errors.length - 5} more)`);
    }
    return { nodesWritten, edgesWritten, duplicatesSkipped, errors };
  }
}
