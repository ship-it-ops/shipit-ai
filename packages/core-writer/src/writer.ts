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

/**
 * Bounded optimistic-concurrency retry cap for the `_claims_rev` CAS. Small by
 * design: a conflict means an api-server manual edit committed between our read and
 * write, which is rare; 3 attempts absorb realistic bursts while guaranteeing the
 * loop terminates (no livelock) under pathological sustained churn — on exhaustion
 * we SKIP the claims write rather than clobber the manual edit.
 */
const CLAIMS_REV_MAX_RETRIES = 3;

export interface WriteResult {
  nodesWritten: number;
  edgesWritten: number;
  duplicatesSkipped: number;
  /**
   * Nodes the freshness guard REJECTED because a strictly-newer version is
   * already stored (an out-of-order/stale delivery). Distinct from
   * `duplicatesSkipped` (unchanged content) so silent suppression is observable
   * and a spike (clock skew, a stale backfill) is distinguishable from healthy dedup.
   */
  freshnessSkipped: number;
  /**
   * Nodes whose `_claims` write was SKIPPED because the `_claims_rev` CAS kept
   * conflicting until the retry cap was exhausted (sustained manual-edit churn
   * raced the resync). Distinct from `freshnessSkipped` (a stale/out-of-order
   * delivery) so the two suppression reasons are separately observable. Unlike
   * the freshness skip, this outcome does NOT record idempotency — a later
   * delivery/retry re-attempts and re-resolves on top of the committed manual claim.
   */
  claimsConflictSkipped: number;
  errors: string[];
}

/** Outcome of a node write. `written` is the freshness-guard verdict (false ⇒ a
 *  strictly-newer version is already stored, nothing written). `claimsConflict` is
 *  the optimistic-concurrency verdict on `_claims_rev`: true ⇒ the freshness guard
 *  passed but `_claims_rev` changed since the read, so the `_claims`/derived-property
 *  write was SKIPPED to avoid clobbering a concurrent manual edit — the caller should
 *  re-read + re-resolve and retry. `claimsWritten` ⇒ claims were written + rev bumped. */
export interface WriteNodeResult {
  written: boolean;
  claimsWritten: boolean;
  claimsConflict: boolean;
}

/** Existing claims read from the graph plus the node's current `_claims_rev`
 *  (coalesced null → 0), captured at read time so it can be threaded into the next
 *  `writeNode` as the optimistic-concurrency expectation. */
export interface ExistingClaims {
  claims: CanonicalNode['_claims'];
  claimsRev: number;
}

export interface NodeWriter {
  /** Returns `written: false` when the freshness guard rejected the write
   *  (a strictly-newer version is already stored), or `claimsConflict: true` when
   *  `_claims_rev` changed since `expectedClaimsRev` was read (the claims write was
   *  skipped to preserve a concurrent manual edit). */
  writeNode(
    node: CanonicalNode,
    mergedClaims: CanonicalNode['_claims'],
    effectiveProperties: Record<string, unknown>,
    expectedClaimsRev?: number,
  ): Promise<WriteNodeResult>;
  writeEdge(edge: CanonicalEdge): Promise<void>;
  getExistingClaims(nodeId: string): Promise<ExistingClaims>;
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
        // The subscribed (event-bus) path would otherwise discard the WriteResult.
        // Surface a one-line summary whenever a batch did something noteworthy so
        // freshness-skips (silent content suppression) and errors are observable.
        const r = await this.processBatch(batch);
        if (r.freshnessSkipped > 0 || r.claimsConflictSkipped > 0 || r.errors.length > 0) {
          console.warn(
            `[CoreWriter] batch: ${r.nodesWritten} written, ${r.duplicatesSkipped} dup, ${r.freshnessSkipped} freshness-skipped, ${r.claimsConflictSkipped} claims-conflict-skipped, ${r.errors.length} errors`,
          );
        }
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
    let freshnessSkipped = 0;
    let claimsConflictSkipped = 0;
    const errors: string[] = [];

    for (const event of batch) {
      const { payload } = event;
      if (!payload || !Array.isArray(payload.nodes)) continue;

      // Process nodes
      for (const node of payload.nodes) {
        try {
          const idempotencyKey = buildNodeIdempotencyKey(event.connector_id, node);

          // Check idempotency first — on a steady-state re-sync most events are
          // duplicates, so we avoid paying a reconcile lookup per known entity.
          if (await this.idempotency.isDuplicate(idempotencyKey)) {
            duplicatesSkipped++;
            // Unchanged entity, but the connector re-confirmed it this run.
            // Refresh only the freshness timestamp (cheap single-property write,
            // no claim re-resolution) so the catalog "Synced" tracks the latest
            // run and staleness reflects connector health, not content churn.
            // Touch by node.id directly: GitHub canonical IDs are deterministic,
            // so a re-synced entity's node.id IS its stored canonical id (a
            // primary-key match), letting us skip reconcile on this hot path.
            // Best effort — a touch failure must not fail the sync.
            if (typeof node._last_synced === 'string') {
              try {
                await this.nodeWriter.touchLastSynced(node.id, node._last_synced);
              } catch {
                // non-critical: timestamp refresh failed, leave it stale
              }
            }
            continue;
          }

          // Reconcile identity
          const reconciliation = await this.reconciler.reconcile(node);

          // Stamp the connector instance ID from the envelope so the graph
          // remembers which configured instance produced this entity
          // (normalizers don't know — only the runner/scheduler does).
          const nodeToWrite: CanonicalNode = {
            ...node,
            id: reconciliation.canonicalId,
            _source_connector_id: event.connector_id,
          };

          // Optimistic-concurrency loop on `_claims_rev`. core-writer is NOT a
          // participant in api-server's manual-edit write-lock, so a manual claim
          // committed by api-server between our read and our write would be lost
          // without this. On a claims-rev conflict we RE-READ (now seeing the
          // api-server-written manual claim) + RE-RESOLVE (the ClaimResolver merges
          // by source, so the `manual:*` claim survives alongside the connector's
          // claims) and retry — bounded to avoid a livelock under sustained churn.
          let written = false;
          let claimsConflict = false;
          for (let attempt = 0; attempt < CLAIMS_REV_MAX_RETRIES; attempt++) {
            // Read existing claims + the lock counter in the SAME logical step so
            // `expectedClaimsRev` is the value we resolved against.
            const existing = await this.nodeWriter.getExistingClaims(reconciliation.canonicalId);

            // Resolve claims (existing ⊕ incoming, per-source merge + strategy).
            const { mergedClaims, effectiveProperties } = this.resolver.resolve(
              existing.claims,
              node._claims,
            );

            // Write node with resolved claims and effective properties. The atomic
            // in-Cypher freshness guard may REJECT this when a strictly-newer
            // version is already stored (out-of-order/stale delivery); the
            // `_claims_rev` CAS may report a conflict when api-server bumped the
            // lock since `existing.claimsRev` was read.
            const result = await this.nodeWriter.writeNode(
              nodeToWrite,
              mergedClaims,
              effectiveProperties,
              existing.claimsRev,
            );
            written = result.written;
            claimsConflict = result.claimsConflict;
            if (!claimsConflict) break;
            // Conflict: an api-server manual edit landed mid-flight. Re-read +
            // re-resolve so the connector's update merges ON TOP of it, then retry.
          }

          if (claimsConflict) {
            // Retry cap exhausted under sustained manual-edit churn. Do NOT clobber:
            // skip the claims write (the freshness guard still refreshed node
            // properties/version). The manual claim is preserved; the connector's
            // claim update is DROPPED this run.
            //
            // Deliberately DO NOT record idempotency here. Recording the
            // content-hash key would make an identical-content resync short-circuit
            // as a duplicate (the isDuplicate check above), so the dropped claim
            // update would NOT be re-applied until the connector's content next
            // changes or the idempotency TTL expires. Leaving the key unrecorded
            // lets a BullMQ retry / next delivery of the SAME payload re-attempt and
            // re-resolve on top of the now-committed manual claim. This does not
            // spin: exhaustion only happens while a concurrent writer keeps bumping
            // `_claims_rev`; once that churn subsides the retry's CAS succeeds and
            // records idempotency normally.
            claimsConflictSkipped++;
            console.warn(
              `[CoreWriter] claims-rev conflict ${nodeToWrite.id}: exhausted ${CLAIMS_REV_MAX_RETRIES} retries, skipped claims write to preserve concurrent manual edit (idempotency NOT recorded → will re-attempt on next delivery)`,
            );
            continue;
          }

          // Record idempotency for every NON-conflict outcome: an accepted write
          // must not reprocess, and a guard-rejected stale delivery must be
          // short-circuited so a BullMQ retry / stream replay of the same payload
          // does not re-run the reconcile + guard every time.
          await this.idempotency.record(idempotencyKey);

          if (written) {
            nodesWritten++;
          } else {
            // Freshness guard rejected (older than stored). Do NOT touchLastSynced
            // — moving "Synced" forward for content we refused to write would lie.
            freshnessSkipped++;
            console.warn(
              `[CoreWriter] freshness-skip ${nodeToWrite.id} incoming _event_version=${String(node._event_version)} not newer than stored`,
            );
          }
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
    return {
      nodesWritten,
      edgesWritten,
      duplicatesSkipped,
      freshnessSkipped,
      claimsConflictSkipped,
      errors,
    };
  }
}
