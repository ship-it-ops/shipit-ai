// Phase 2: Reconciliation service — fuzzy entity-match scan + manual review.
// Uses lexical similarity (Jaro-Winkler on name + trigram on namespace +
// Jaccard on tag/label sets) per design doc §5.3. Vector embeddings are
// deferred to a later mini-phase.
//
// State model in Neo4j:
//   (cand:ReconciliationCandidate {id, status, ...}) -[:LEFT]->(a)
//   (cand)-[:RIGHT]->(b)
//   (a)-[:DISTINCT_FROM]->(b)              after "mark distinct"
//   (m:MergeEvent {...})-[:MERGED]->(survivor), (m)-[:ABSORBED]->(loser)
//
// All mutations go through this service, not the Cypher playground.
import { randomUUID } from 'node:crypto';
import type {
  CandidateDetail,
  MergeEventSummary,
  PropertyClaim,
  ReconciliationCandidate,
  ReconciliationStats,
} from '@shipit-ai/shared';
import { sourceKey } from '@shipit-ai/shared';
import type { ManagedTransaction } from 'neo4j-driver';
import type { Neo4jService } from './neo4j-service.js';
import { loadClaimsLocked, writeClaims } from './claim-write-helpers.js';
import { jaroWinkler, setSimilarity, trigramJaccard } from './string-similarity.js';

// Above this, the design doc allows auto-merge. We surface them as
// pending candidates regardless — keeps Phase 2 in the "human approves" mode.
const AUTO_MERGE_CEILING = 0.95;

// Weights per design doc §5.3.
const WEIGHTS = { name: 0.5, namespace: 0.2, tags: 0.2, labels: 0.1 } as const;

// Labels that get fuzzy-matched. Identity-ambiguous types where the same
// real-world entity often shows up under different names (Backstage `Component`
// vs K8s `Deployment` annotation). Deployments and Monitors are excluded —
// they're naturally fan-outs of a parent and predictably share long name
// prefixes, which would generate noisy candidates. Cross-label matching is
// intentionally out of scope per design doc §5.3.1.
const FUZZY_LABELS = ['LogicalService', 'Repository', 'RuntimeService', 'Team'];

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value ?? 0);
}

function asString(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  return String(value);
}

interface NodeRow {
  id: string;
  name: string;
  namespace: string;
  tags: string[];
  labels: string[];
  source: string | null;
  properties: Record<string, unknown>;
}

// Weighted average that skips features with no signal on either side.
// Without this, an entity missing tags would always score 0 on the tag
// component, dragging confidence below threshold even when name + namespace
// agree perfectly. The design doc weights are intent ratios, not absolute
// floors — we renormalize over only the features that actually apply.
function scorePair(a: NodeRow, b: NodeRow) {
  const components: Array<{ key: keyof typeof WEIGHTS; value: number; applies: boolean }> = [
    { key: 'name', value: jaroWinkler(a.name, b.name), applies: !!a.name && !!b.name },
    {
      key: 'namespace',
      value: trigramJaccard(a.namespace, b.namespace),
      applies: !!a.namespace && !!b.namespace,
    },
    {
      key: 'tags',
      value: setSimilarity(a.tags, b.tags),
      applies: a.tags.length > 0 && b.tags.length > 0,
    },
    {
      key: 'labels',
      value: setSimilarity(a.labels, b.labels),
      applies: a.labels.length > 0 && b.labels.length > 0,
    },
  ];
  let sum = 0;
  let totalWeight = 0;
  const breakdown: Record<string, number> = {};
  for (const c of components) {
    breakdown[c.key] = c.value;
    if (!c.applies) continue;
    sum += c.value * WEIGHTS[c.key];
    totalWeight += WEIGHTS[c.key];
  }
  const confidence = totalWeight === 0 ? 0 : sum / totalWeight;
  return {
    confidence,
    breakdown: {
      name: breakdown.name,
      namespace: breakdown.namespace,
      tags: breakdown.tags,
      labels: breakdown.labels,
    },
  };
}

function nodeFromRow(row: { properties: Record<string, unknown>; labels?: string[] }): NodeRow {
  const props = row.properties;
  const id = asString(props.id);
  // Use the last URL segment as a fallback name to keep scoring stable for
  // nodes that haven't been claim-resolved yet.
  const fallbackName = id.split('/').pop() ?? id;
  const tagsRaw = props.tags as unknown;
  const labelsRaw = props.labels as unknown;
  return {
    id,
    name: asString(props.name, fallbackName),
    // `_source_org` is the *origin* of the claim (e.g., "github/shipitops") —
    // using it as a fallback namespace makes two K8s/Backstage entities from
    // the same source-org look "namespaced together" by accident. Only treat
    // an explicit `namespace` property as namespace data.
    namespace: asString(props.namespace ?? ''),
    tags: Array.isArray(tagsRaw) ? tagsRaw.map(String) : [],
    labels: Array.isArray(labelsRaw) ? labelsRaw.map(String) : [],
    source: props._source_system ? asString(props._source_system) : null,
    properties: props,
  };
}

export class ReconciliationService {
  private lastScanAt: string | null = null;
  constructor(
    private neo4j: Neo4jService,
    private threshold: number,
  ) {}

  async stats(): Promise<ReconciliationStats> {
    const records = await this.neo4j.runQuery(
      `OPTIONAL MATCH (c:ReconciliationCandidate {status: 'pending'})
       WITH count(c) AS pending
       OPTIONAL MATCH (m:MergeEvent)
       WHERE m.timestamp > datetime() - duration({days: 30})
       RETURN pending, count(m) AS recentMerges`,
    );
    const record = records[0];
    return {
      pending: record ? asNumber(record.get('pending')) : 0,
      recentMerges: record ? asNumber(record.get('recentMerges')) : 0,
      lastScanAt: this.lastScanAt,
    };
  }

  /**
   * Wipe pending candidates. Use after tuning the scan to remove stale rows.
   * Does not touch confirmed/rejected/distinct candidates — those are user
   * decisions that should survive a re-scan.
   */
  async resetPending(): Promise<number> {
    const records = await this.neo4j.runQuery(
      `MATCH (c:ReconciliationCandidate {status: 'pending'})
       WITH c, c.id AS id DETACH DELETE c RETURN count(id) AS removed`,
    );
    return records[0] ? asNumber(records[0].get('removed')) : 0;
  }

  /** Run a full scan and persist new pending candidates. Skips known DISTINCT_FROM pairs. */
  async scan(): Promise<number> {
    let created = 0;
    for (const label of FUZZY_LABELS) {
      const records = await this.neo4j.runQuery(
        `MATCH (n:${label})
         WHERE coalesce(n._deleted, false) = false
         RETURN n LIMIT 500`,
      );
      const nodes = records.map((r) => nodeFromRow(r.get('n')));

      // Build a set of already-known non-pairings so we don't re-flag rejected
      // candidates on every scan.
      const skipPairs = await this.loadSkipPairs(nodes.map((n) => n.id));

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          if (a.id === b.id) continue;
          if (skipPairs.has(pairKey(a.id, b.id))) continue;
          const score = scorePair(a, b);
          if (score.confidence < this.threshold) continue;
          if (score.confidence > AUTO_MERGE_CEILING && a.name === b.name) continue; // identical → not a fuzzy candidate
          await this.upsertCandidate(label, a, b, score);
          created++;
        }
      }
    }
    this.lastScanAt = new Date().toISOString();
    return created;
  }

  private async loadSkipPairs(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const records = await this.neo4j.runQuery(
      `MATCH (a)-[:DISTINCT_FROM]->(b) WHERE a.id IN $ids OR b.id IN $ids
       RETURN a.id AS aid, b.id AS bid
       UNION
       MATCH (c:ReconciliationCandidate)-[:LEFT]->(a)
       MATCH (c)-[:RIGHT]->(b)
       WHERE (a.id IN $ids OR b.id IN $ids) AND c.status IN ['pending','rejected','confirmed']
       RETURN a.id AS aid, b.id AS bid`,
      { ids },
    );
    const set = new Set<string>();
    for (const rec of records) set.add(pairKey(asString(rec.get('aid')), asString(rec.get('bid'))));
    return set;
  }

  private async upsertCandidate(
    label: string,
    a: NodeRow,
    b: NodeRow,
    score: ReturnType<typeof scorePair>,
  ): Promise<void> {
    const id = `rc:${randomUUID()}`;
    await this.neo4j.runQuery(
      `MATCH (a {id: $aid}), (b {id: $bid})
       CREATE (c:ReconciliationCandidate {
         id: $id,
         status: 'pending',
         label: $label,
         confidence: $confidence,
         scoreName: $sn,
         scoreNamespace: $snm,
         scoreTags: $st,
         scoreLabels: $sl,
         createdAt: datetime(),
         reviewedAt: null,
         reviewedBy: null
       })
       CREATE (c)-[:LEFT]->(a)
       CREATE (c)-[:RIGHT]->(b)`,
      {
        id,
        aid: a.id,
        bid: b.id,
        label,
        confidence: score.confidence,
        sn: score.breakdown.name,
        snm: score.breakdown.namespace,
        st: score.breakdown.tags,
        sl: score.breakdown.labels,
      },
    );
  }

  async listCandidates(opts: {
    status?: ReconciliationCandidate['status'];
    limit?: number;
  }): Promise<ReconciliationCandidate[]> {
    const status = opts.status ?? 'pending';
    const limit = Math.min(opts.limit ?? 100, 500);
    const records = await this.neo4j.runQuery(
      `MATCH (c:ReconciliationCandidate {status: $status})-[:LEFT]->(a)
       MATCH (c)-[:RIGHT]->(b)
       RETURN c, a, b ORDER BY c.confidence DESC, c.createdAt DESC LIMIT toInteger($limit)`,
      { status, limit },
    );
    return records.map((rec) => candidateFromRecord(rec));
  }

  async getCandidate(id: string): Promise<CandidateDetail | null> {
    const records = await this.neo4j.runQuery(
      `MATCH (c:ReconciliationCandidate {id: $id})-[:LEFT]->(a)
       MATCH (c)-[:RIGHT]->(b)
       RETURN c, a, b LIMIT 1`,
      { id },
    );
    if (records.length === 0) return null;
    const summary = candidateFromRecord(records[0]);
    const a = records[0].get('a') as { properties: Record<string, unknown> };
    const b = records[0].get('b') as { properties: Record<string, unknown> };
    return { ...summary, leftProperties: a.properties, rightProperties: b.properties };
  }

  async confirmMerge(id: string, actor: string): Promise<MergeEventSummary> {
    const candidate = await this.getCandidate(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);
    if (candidate.status !== 'pending') {
      throw new Error(`Candidate ${id} is ${candidate.status}, expected pending`);
    }

    // Pick the survivor: highest-confidence claim on `name` (tie-break to the
    // one with more total claims). The other node is soft-deleted with a
    // pointer back to the survivor so existing references can be redirected.
    const survivor = pickSurvivor(candidate);
    const loser = survivor === candidate.leftId ? candidate.rightId : candidate.leftId;

    const mergeId = `me:${randomUUID()}`;
    const loserSnapshot = JSON.stringify(
      survivor === candidate.leftId ? candidate.rightProperties : candidate.leftProperties,
    );

    // Whole merge — human-claim migration + audit re-point + soft-delete — runs in
    // ONE write transaction so the durability promise holds atomically: a manual
    // override carried by the loser never vanishes between the soft-delete and the
    // migration. The claims read/write honors the shared `_claims_rev` lock
    // authority (loadClaimsLocked/writeClaims) that both api-server writers and
    // core-writer's mergeNode CAS-check, so a connector resync racing this merge
    // can't clobber the migrated claims.
    await this.neo4j.runInWriteTransaction(async (tx) => {
      await this.migrateHumanClaims(tx, loser, survivor);
      await repointAuditEvents(tx, loser, survivor);
      await tx.run(
        `MATCH (s {id: $survivor}), (l {id: $loser}), (c:ReconciliationCandidate {id: $cid})
         CREATE (m:MergeEvent {
           id: $mergeId,
           actor: $actor,
           timestamp: datetime(),
           method: 'fuzzy',
           confidence: $confidence,
           survivorId: $survivor,
           loserId: $loser,
           loserSnapshot: $loserSnapshot
         })
         CREATE (m)-[:MERGED]->(s)
         CREATE (m)-[:ABSORBED]->(l)
         SET l._deleted = true,
             l._merged_into = $survivor,
             l._merged_at = m.timestamp,
             c.status = 'confirmed',
             c.reviewedAt = m.timestamp,
             c.reviewedBy = $actor`,
        {
          cid: id,
          mergeId,
          survivor,
          loser,
          actor,
          confidence: candidate.confidence,
          loserSnapshot,
        },
      );
    });

    return {
      id: mergeId,
      sourceId: loser,
      targetId: survivor,
      sourceName: survivor === candidate.leftId ? candidate.rightName : candidate.leftName,
      targetName: survivor === candidate.leftId ? candidate.leftName : candidate.rightName,
      actor,
      timestamp: new Date().toISOString(),
      method: 'fuzzy',
      confidence: candidate.confidence,
    };
  }

  /**
   * Migrate the loser's human-attestation claims (`manual:*` / `verified:*`) onto
   * the survivor, inside `tx`. Without this, a node carrying a manual override that
   * loses an identity merge would have that override silently dropped — the
   * survivor is the visible node, but the override lives on the soft-deleted loser.
   *
   * Both writers are locked via `loadClaimsLocked` (it bumps `_claims_rev`, taking
   * each node's write lock), so a concurrent connector resync serializes behind
   * this merge rather than racing it.
   *
   * ONLY human attestations migrate: connector claims (github/datadog/…) are
   * re-derived on the next resync of the survivor and would just be stale noise.
   * `verified:*` migrates alongside `manual:*` — both are irreplaceable human input
   * resolved by the same MANUAL_OVERRIDE_FIRST winner, so dropping verified would
   * be the same durability bug one rung up.
   *
   * Merge is by the codebase's claim identity `(source, source_id, property_key)`
   * (mirrors ClaimResolver.mergeClaims): a loser claim whose triple already exists
   * on the survivor is skipped, so no duplicates and the survivor's own copy wins a
   * true collision. The survivor's per-property winner is re-resolved by the shared
   * read-path resolver on the next read, so a migrated manual override wins where
   * it should.
   */
  private async migrateHumanClaims(
    tx: ManagedTransaction,
    loser: string,
    survivor: string,
  ): Promise<void> {
    // Locking the loser first (lower-or-higher id ordering is irrelevant here:
    // a merge holds a unique candidate, so two merges can't contend the same pair).
    const loserLocked = await loadClaimsLocked(tx, loser);
    const survivorLocked = await loadClaimsLocked(tx, survivor);
    if (!loserLocked || !survivorLocked) return; // a node vanished mid-merge — nothing to migrate

    const humanClaims = loserLocked.claims.filter((c) => isHumanAttestation(c));
    if (humanClaims.length === 0) return;

    const merged = mergeClaimsByIdentity(survivorLocked.claims, humanClaims);
    // Only write when migration actually added a claim — avoids a needless rev bump
    // and `_claims` rewrite when the survivor already holds every human claim.
    if (merged.length !== survivorLocked.claims.length) {
      await writeClaims(tx, survivor, merged);
    }
  }

  async reject(id: string, actor: string): Promise<void> {
    const result = await this.neo4j.runQuery(
      `MATCH (c:ReconciliationCandidate {id: $id})
       WHERE c.status = 'pending'
       SET c.status = 'rejected', c.reviewedAt = datetime(), c.reviewedBy = $actor
       RETURN c.id AS id`,
      { id, actor },
    );
    if (result.length === 0) throw new Error(`Candidate ${id} not found or not pending`);
  }

  /** Mark distinct: writes a DISTINCT_FROM edge so the scan won't re-propose this pair. */
  async markDistinct(id: string, actor: string): Promise<void> {
    const candidate = await this.getCandidate(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);
    if (candidate.status !== 'pending') {
      throw new Error(`Candidate ${id} is ${candidate.status}, expected pending`);
    }
    await this.neo4j.runQuery(
      `MATCH (c:ReconciliationCandidate {id: $id})-[:LEFT]->(a)
       MATCH (c)-[:RIGHT]->(b)
       MERGE (a)-[:DISTINCT_FROM]->(b)
       SET c.status = 'distinct', c.reviewedAt = datetime(), c.reviewedBy = $actor`,
      { id, actor: actor },
    );
  }

  async listMerges(limit: number = 50): Promise<MergeEventSummary[]> {
    const records = await this.neo4j.runQuery(
      `MATCH (m:MergeEvent)
       OPTIONAL MATCH (m)-[:MERGED]->(s)
       OPTIONAL MATCH (m)-[:ABSORBED]->(l)
       RETURN m, s, l ORDER BY m.timestamp DESC LIMIT toInteger($limit)`,
      { limit },
    );
    return records.map((rec) => {
      const m = rec.get('m') as { properties: Record<string, unknown> };
      const s = rec.get('s') as { properties: Record<string, unknown> } | null;
      const l = rec.get('l') as { properties: Record<string, unknown> } | null;
      const ts = m.properties.timestamp;
      return {
        id: asString(m.properties.id),
        sourceId: asString(m.properties.loserId),
        targetId: asString(m.properties.survivorId),
        sourceName: l
          ? asString(l.properties.name, asString(m.properties.loserId))
          : asString(m.properties.loserId),
        targetName: s
          ? asString(s.properties.name, asString(m.properties.survivorId))
          : asString(m.properties.survivorId),
        actor: asString(m.properties.actor),
        timestamp: typeof ts === 'object' && ts && 'toString' in ts ? String(ts) : asString(ts),
        method: (asString(m.properties.method) || 'fuzzy') as MergeEventSummary['method'],
        confidence: asNumber(m.properties.confidence),
      };
    });
  }

  /** Reverse a merge: restore the loser and detach the MergeEvent. */
  async splitMerge(mergeId: string, actor: string): Promise<void> {
    const result = await this.neo4j.runQuery(
      `MATCH (m:MergeEvent {id: $id})
       OPTIONAL MATCH (m)-[:ABSORBED]->(l)
       WITH m, l
       SET l._deleted = false
       REMOVE l._merged_into, l._merged_at
       WITH m
       SET m.reversedAt = datetime(), m.reversedBy = $actor
       RETURN m.id AS id`,
      { id: mergeId, actor },
    );
    if (result.length === 0) throw new Error(`MergeEvent ${mergeId} not found`);
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** A human-authored attestation claim (`manual:<actor>` or `verified:<actor>`). */
function isHumanAttestation(claim: PropertyClaim): boolean {
  const key = sourceKey(claim.source);
  return key === 'manual' || key === 'verified';
}

/**
 * Merge `incoming` claims into `base`, deduped by the codebase's claim identity
 * `(source, source_id, property_key)` (the same key ClaimResolver.mergeClaims uses).
 * A claim whose triple already exists in `base` is skipped so the survivor's own
 * copy wins a true collision and migration never duplicates a claim.
 */
// DEFERRED (acknowledged): migrated claims keep the loser's `source_id`; not
// rewritten to the survivor. Harmless for resolution today (identity is the full
// triple) — revisit if source_id ever needs to point at the survivor.
function mergeClaimsByIdentity(base: PropertyClaim[], incoming: PropertyClaim[]): PropertyClaim[] {
  const merged = [...base];
  for (const claim of incoming) {
    const exists = merged.some(
      (c) =>
        c.source === claim.source &&
        c.source_id === claim.source_id &&
        c.property_key === claim.property_key,
    );
    if (!exists) merged.push(claim);
  }
  return merged;
}

/**
 * Re-point the loser's audit trail at the survivor: `GraphEditEvent` edits
 * (`[:EDITS]`) and `VerificationEvent` verifications (`[:VERIFIES]`). After an
 * identity merge the survivor is the visible node, so its audit history must
 * include events that were recorded against the soft-deleted loser — otherwise
 * those events dangle on a hidden `_deleted` node and disappear from the UI.
 *
 * One query per relationship type: a Neo4j relationship type can't be
 * parameterized, and "re-pointing" is create-new-of-same-type + delete-old. The
 * type list is a fixed, code-controlled allowlist (never user input), so the
 * interpolation is safe.
 */
async function repointAuditEvents(
  tx: ManagedTransaction,
  loser: string,
  survivor: string,
): Promise<void> {
  for (const relType of AUDIT_REL_TYPES) {
    await tx.run(
      `MATCH (s {id: $survivor})
       MATCH (e)-[r:${relType}]->(l {id: $loser})
       CREATE (e)-[:${relType}]->(s)
       DELETE r`,
      { loser, survivor },
    );
  }
}

/** Audit-edge types whose events follow the visible node across an identity merge. */
const AUDIT_REL_TYPES = ['EDITS', 'VERIFIES'] as const;

function candidateFromRecord(rec: { get: (k: string) => unknown }): ReconciliationCandidate {
  const c = rec.get('c') as { properties: Record<string, unknown> };
  const a = rec.get('a') as { properties: Record<string, unknown> };
  const b = rec.get('b') as { properties: Record<string, unknown> };
  const ts = c.properties.createdAt;
  const reviewedAt = c.properties.reviewedAt;
  return {
    id: asString(c.properties.id),
    status: (asString(c.properties.status) || 'pending') as ReconciliationCandidate['status'],
    leftId: asString(a.properties.id),
    leftName: asString(a.properties.name, asString(a.properties.id).split('/').pop() ?? ''),
    leftSource: a.properties._source_system ? asString(a.properties._source_system) : null,
    rightId: asString(b.properties.id),
    rightName: asString(b.properties.name, asString(b.properties.id).split('/').pop() ?? ''),
    rightSource: b.properties._source_system ? asString(b.properties._source_system) : null,
    label: asString(c.properties.label),
    confidence: asNumber(c.properties.confidence),
    scoreBreakdown: {
      name: asNumber(c.properties.scoreName),
      namespace: asNumber(c.properties.scoreNamespace),
      tags: asNumber(c.properties.scoreTags),
      labels: asNumber(c.properties.scoreLabels),
    },
    createdAt: typeof ts === 'object' && ts && 'toString' in ts ? String(ts) : asString(ts),
    reviewedAt:
      reviewedAt == null
        ? null
        : typeof reviewedAt === 'object' && 'toString' in reviewedAt
          ? String(reviewedAt)
          : asString(reviewedAt),
    reviewedBy: c.properties.reviewedBy != null ? asString(c.properties.reviewedBy) : null,
  };
}

function pickSurvivor(candidate: CandidateDetail): string {
  // Tier-1 or production wins. Otherwise the older `_last_synced` wins (more
  // established record). Final fallback: alphabetical id for determinism.
  const left = candidate.leftProperties;
  const right = candidate.rightProperties;
  const leftTier = Number(left.tier_effective ?? left.tier ?? 99);
  const rightTier = Number(right.tier_effective ?? right.tier ?? 99);
  if (leftTier !== rightTier) return leftTier < rightTier ? candidate.leftId : candidate.rightId;
  const leftSync = asString(left._last_synced);
  const rightSync = asString(right._last_synced);
  if (leftSync && rightSync && leftSync !== rightSync) {
    return leftSync < rightSync ? candidate.leftId : candidate.rightId;
  }
  return candidate.leftId < candidate.rightId ? candidate.leftId : candidate.rightId;
}
