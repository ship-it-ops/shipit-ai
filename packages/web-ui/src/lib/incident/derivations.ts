/**
 * Pure derivation functions for the Incident Mode dashboard.
 *
 * Inputs: a `GraphData` neighborhood (depth 1) and/or a blast-radius graph,
 * plus the start service id. Outputs: panel-ready, sorted, typed shapes.
 *
 * Everything in this file is a pure function — no React, no fetch, no state.
 * That's the design constraint: the rules that say "this is a T1 service
 * with 12 dependents and the verdict is RED" should be unit-testable in
 * isolation, because they're the rules an SRE will rely on at 2 AM.
 */

import type { GraphData, GraphEdge, GraphNode } from '../api';
import type {
  DeploymentContext,
  MonitorContext,
  PersonContext,
  RepositoryContext,
  ServiceContext,
  TeamContext,
} from '../integrations';

// ─────────────────────────────────────────────────────────────────────────────
// Domain types — minimal shapes each panel actually needs.
// ─────────────────────────────────────────────────────────────────────────────

export interface ServiceNode {
  id: string;
  name: string;
  type: string;
  tier?: number;
  lifecycle?: string;
  environment?: string;
  ownerSlug?: string;
  ddService?: string;
  language?: string;
  domain?: string;
  hasPii?: boolean;
  lastSynced?: string;
  lastSyncedAgeSeconds?: number;
  /** Anything else from the underlying GraphNode payload. */
  raw: GraphNode['data'];
}

export interface DependencyEntry {
  id: string;
  name: string;
  type: string;
  tier?: number;
  owner?: string;
  relation: string;
}

export interface BlastRadiusEntry {
  id: string;
  name: string;
  type: string;
  tier?: number;
  owner?: string;
}

export interface RecentChangeEntry {
  id: string;
  name: string;
  type: 'Deployment' | 'Pipeline' | 'BuildArtifact';
  status?: string;
  environment?: string;
  lastSynced?: string;
  lastSyncedAgeSeconds?: number;
}

export interface MonitorEntry {
  id: string;
  name: string;
  severity?: string;
  runbookUrl?: string;
  ddMonitorId?: string;
  url?: string;
  raw: GraphNode['data'];
}

export interface Responders {
  onCall: PersonContext[];
  owningTeams: TeamContext[];
  codeOwners: { teams: TeamContext[]; people: PersonContext[] };
}

export type SafetyLevel = 'green' | 'yellow' | 'red' | 'unknown';

export interface SafetyVerdict {
  level: SafetyLevel;
  label: string;
  reasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function asNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return String(v);
}

function isOutboundOf(edge: GraphEdge, id: string): boolean {
  return edge.data.source === id;
}

function isInboundTo(edge: GraphEdge, id: string): boolean {
  return edge.data.target === id;
}

function nodeById(graph: GraphData, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.data.id === id);
}

const DEPENDENCY_RELATIONS = new Set(['DEPENDS_ON', 'CALLS']);

// ─────────────────────────────────────────────────────────────────────────────
// Service node parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull the service node out of the neighborhood and project it into the
 * minimal `ServiceNode` shape every panel uses. Returns undefined if the
 * service isn't in the graph (typo / 404 case).
 */
export function findService(graph: GraphData | undefined, id: string): ServiceNode | undefined {
  if (!graph) return undefined;
  const node = nodeById(graph, id);
  if (!node) return undefined;
  const d = node.data;
  return {
    id: String(d.id),
    name: asString(d.name) ?? String(d.id),
    type: asString(d.type) ?? 'Unknown',
    tier: asNumber(d.tier_effective ?? d.tier),
    lifecycle: asString(d.lifecycle),
    environment: asString(d.environment),
    ownerSlug: asString(d.owner),
    ddService: asString(d.dd_service ?? d.apm_name),
    language: asString(d.language),
    domain: asString(d.domain),
    hasPii: typeof d.contains_pii === 'boolean' ? d.contains_pii : undefined,
    lastSynced: asString(d._last_synced),
    lastSyncedAgeSeconds: asNumber(d._last_synced_age_seconds),
    raw: d,
  };
}

/** Build the `ServiceContext` adapters expect. */
export function serviceContext(service: ServiceNode): ServiceContext {
  return {
    id: service.id,
    name: service.name,
    ddService: service.ddService,
    tier: service.tier,
    ownerSlug: service.ownerSlug,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies (depth-1)
// ─────────────────────────────────────────────────────────────────────────────

function makeDependencyEntry(
  graph: GraphData,
  otherId: string,
  relation: string,
): DependencyEntry | null {
  const node = nodeById(graph, otherId);
  if (!node) return null;
  const d = node.data;
  return {
    id: String(d.id),
    name: asString(d.name) ?? String(d.id),
    type: asString(d.type) ?? 'Unknown',
    tier: asNumber(d.tier_effective ?? d.tier),
    owner: asString(d.owner),
    relation,
  };
}

export function directDependencies(
  graph: GraphData | undefined,
  serviceId: string,
): DependencyEntry[] {
  if (!graph) return [];
  return graph.edges
    .filter((e) => isOutboundOf(e, serviceId) && DEPENDENCY_RELATIONS.has(String(e.data.type)))
    .map((e) => makeDependencyEntry(graph, String(e.data.target), String(e.data.type)))
    .filter((x): x is DependencyEntry => x !== null);
}

export function directDependents(
  graph: GraphData | undefined,
  serviceId: string,
): DependencyEntry[] {
  if (!graph) return [];
  return graph.edges
    .filter((e) => isInboundTo(e, serviceId) && DEPENDENCY_RELATIONS.has(String(e.data.type)))
    .map((e) => makeDependencyEntry(graph, String(e.data.source), String(e.data.type)))
    .filter((x): x is DependencyEntry => x !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blast radius — ranked table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rank blast-radius nodes for the IC's first 60 seconds.
 *
 * Sort: tier ascending (T1 first, unknown last) then inbound-degree
 * descending (high-fan-out services rank above leaves) then name. This
 * yields a paste-able list — the SRE's actual workflow per persona research.
 */
export function rankedBlastRadius(
  blast: GraphData | undefined,
  startId: string,
): BlastRadiusEntry[] {
  if (!blast) return [];

  // Inbound-degree only counts within the blast subgraph — i.e., how many
  // *other affected* services depend on this one. That answers "if I fix
  // this one, how many cascade unblock?" which is a richer signal than raw
  // inbound count from the whole graph.
  const inboundCount = new Map<string, number>();
  for (const edge of blast.edges) {
    const t = String(edge.data.target);
    inboundCount.set(t, (inboundCount.get(t) ?? 0) + 1);
  }

  return blast.nodes
    .filter((n) => n.data.id !== startId)
    .map((n) => {
      const d = n.data;
      return {
        id: String(d.id),
        name: asString(d.name) ?? String(d.id),
        type: asString(d.type) ?? 'Unknown',
        tier: asNumber(d.tier_effective ?? d.tier),
        owner: asString(d.owner),
      } satisfies BlastRadiusEntry;
    })
    .sort((a, b) => {
      const ta = a.tier ?? 99;
      const tb = b.tier ?? 99;
      if (ta !== tb) return ta - tb;
      const da = inboundCount.get(a.id) ?? 0;
      const db = inboundCount.get(b.id) ?? 0;
      if (da !== db) return db - da;
      return a.name.localeCompare(b.name);
    });
}

export function blastRadiusSummary(entries: BlastRadiusEntry[]): {
  total: number;
  tier1: number;
  tier2: number;
  byOwner: number;
} {
  const owners = new Set<string>();
  let tier1 = 0;
  let tier2 = 0;
  for (const e of entries) {
    if (e.tier === 1) tier1++;
    else if (e.tier === 2) tier2++;
    if (e.owner) owners.add(e.owner);
  }
  return { total: entries.length, tier1, tier2, byOwner: owners.size };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent changes
// ─────────────────────────────────────────────────────────────────────────────

const CHANGE_TYPES = new Set(['Deployment', 'Pipeline', 'BuildArtifact']);

export function recentChanges(
  graph: GraphData | undefined,
  serviceId: string,
  limit: number = 5,
): RecentChangeEntry[] {
  if (!graph) return [];
  const connected = new Set<string>();
  for (const e of graph.edges) {
    if (e.data.source === serviceId) connected.add(String(e.data.target));
    if (e.data.target === serviceId) connected.add(String(e.data.source));
  }
  const entries: RecentChangeEntry[] = [];
  for (const n of graph.nodes) {
    const id = String(n.data.id);
    if (!connected.has(id)) continue;
    const type = asString(n.data.type);
    if (!type || !CHANGE_TYPES.has(type)) continue;
    entries.push({
      id,
      name: asString(n.data.name) ?? id,
      type: type as RecentChangeEntry['type'],
      status: asString(n.data.status),
      environment: asString(n.data.environment),
      lastSynced: asString(n.data._last_synced),
      lastSyncedAgeSeconds: asNumber(n.data._last_synced_age_seconds),
    });
  }
  // Sort by sync time desc; oldest first when ages are missing so they fall
  // off naturally instead of pretending to be fresh.
  entries.sort((a, b) => {
    const aa = a.lastSyncedAgeSeconds ?? Number.POSITIVE_INFINITY;
    const bb = b.lastSyncedAgeSeconds ?? Number.POSITIVE_INFINITY;
    return aa - bb;
  });
  return entries.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitors
// ─────────────────────────────────────────────────────────────────────────────

export function monitorsFor(graph: GraphData | undefined, serviceId: string): MonitorEntry[] {
  if (!graph) return [];
  const monitorIds = new Set<string>();
  for (const e of graph.edges) {
    if (String(e.data.type) !== 'MONITORS') continue;
    if (e.data.target === serviceId) monitorIds.add(String(e.data.source));
  }
  const entries: MonitorEntry[] = [];
  for (const n of graph.nodes) {
    const id = String(n.data.id);
    if (!monitorIds.has(id)) continue;
    entries.push({
      id,
      name: asString(n.data.name) ?? id,
      severity: asString(n.data.severity),
      runbookUrl: asString(n.data.runbook_url ?? n.data.runbook),
      ddMonitorId: asString(n.data.dd_monitor_id ?? n.data.monitor_id),
      url: asString(n.data.url),
      raw: n.data,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

export function monitorContext(monitor: MonitorEntry): MonitorContext {
  return {
    id: monitor.id,
    name: monitor.name,
    ddMonitorId: monitor.ddMonitorId,
    url: monitor.url,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Repositories / Deployments
// ─────────────────────────────────────────────────────────────────────────────

export function repositoriesFor(
  graph: GraphData | undefined,
  serviceId: string,
): RepositoryContext[] {
  if (!graph) return [];
  const repoIds = new Set<string>();
  for (const e of graph.edges) {
    if (String(e.data.type) !== 'IMPLEMENTED_BY') continue;
    if (e.data.source === serviceId) repoIds.add(String(e.data.target));
  }
  return graph.nodes
    .filter((n) => repoIds.has(String(n.data.id)) && asString(n.data.type) === 'Repository')
    .map((n) => ({
      id: String(n.data.id),
      name: asString(n.data.name) ?? String(n.data.id),
      url: asString(n.data.url),
      defaultBranch: asString(n.data.default_branch),
    }));
}

export function deploymentsFor(
  graph: GraphData | undefined,
  serviceId: string,
): DeploymentContext[] {
  if (!graph) return [];
  const depIds = new Set<string>();
  for (const e of graph.edges) {
    if (String(e.data.type) !== 'DEPLOYED_AS') continue;
    if (e.data.source === serviceId) depIds.add(String(e.data.target));
  }
  return graph.nodes
    .filter((n) => depIds.has(String(n.data.id)) && asString(n.data.type) === 'Deployment')
    .map((n) => ({
      id: String(n.data.id),
      name: asString(n.data.name) ?? String(n.data.id),
      cluster: asString(n.data.cluster),
      namespace: asString(n.data.namespace),
      environment: asString(n.data.environment),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Responders
// ─────────────────────────────────────────────────────────────────────────────

function asPerson(node: GraphNode): PersonContext {
  const d = node.data;
  return {
    id: String(d.id),
    name: asString(d.name) ?? asString(d.login) ?? String(d.id),
    login: asString(d.login),
    email: asString(d.email),
  };
}

function asTeam(node: GraphNode): TeamContext {
  const d = node.data;
  return {
    id: String(d.id),
    name: asString(d.name) ?? asString(d.slug) ?? String(d.id),
    slug: asString(d.slug) ?? (asString(d.name) ?? String(d.id)).toLowerCase(),
    email: asString(d.email),
  };
}

/**
 * Resolve the responder hierarchy from a depth-1 neighborhood.
 *
 *   - On-call: Person ON_CALL_FOR LogicalService (the human to page)
 *   - Owning team: Team OWNS LogicalService
 *   - Code owners: Team|Person CODEOWNER_OF Repository, where the
 *     Repository is IMPLEMENTED_BY the service
 *
 * The persona research separates these explicitly: the on-call person is
 * "page now," the code owners are "wake if needed (SMEs)." We surface both
 * because that distinction has saved real incidents.
 */
export function responders(graph: GraphData | undefined, serviceId: string): Responders {
  const empty: Responders = {
    onCall: [],
    owningTeams: [],
    codeOwners: { teams: [], people: [] },
  };
  if (!graph) return empty;

  const nodesById = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodesById.set(String(n.data.id), n);

  const onCall: PersonContext[] = [];
  const owningTeams: TeamContext[] = [];
  const repoIds = new Set<string>();

  for (const e of graph.edges) {
    const type = String(e.data.type);
    if (type === 'ON_CALL_FOR' && e.data.target === serviceId) {
      const p = nodesById.get(String(e.data.source));
      if (p && asString(p.data.type) === 'Person') onCall.push(asPerson(p));
    } else if (type === 'OWNS' && e.data.target === serviceId) {
      const t = nodesById.get(String(e.data.source));
      if (t && asString(t.data.type) === 'Team') owningTeams.push(asTeam(t));
    } else if (type === 'IMPLEMENTED_BY' && e.data.source === serviceId) {
      repoIds.add(String(e.data.target));
    }
  }

  const codeOwnerTeams: TeamContext[] = [];
  const codeOwnerPeople: PersonContext[] = [];
  const seenTeam = new Set<string>();
  const seenPerson = new Set<string>();
  for (const e of graph.edges) {
    if (String(e.data.type) !== 'CODEOWNER_OF') continue;
    if (!repoIds.has(String(e.data.target))) continue;
    const owner = nodesById.get(String(e.data.source));
    if (!owner) continue;
    const t = asString(owner.data.type);
    if (t === 'Team') {
      const team = asTeam(owner);
      if (!seenTeam.has(team.id)) {
        seenTeam.add(team.id);
        codeOwnerTeams.push(team);
      }
    } else if (t === 'Person') {
      const person = asPerson(owner);
      if (!seenPerson.has(person.id)) {
        seenPerson.add(person.id);
        codeOwnerPeople.push(person);
      }
    }
  }

  return {
    onCall,
    owningTeams,
    codeOwners: { teams: codeOwnerTeams, people: codeOwnerPeople },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Staleness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Oldest sync age across a set of nodes. Returns undefined when no node has
 * the server-computed age yet (older API versions). Intentionally biased
 * toward the WORST staleness — a fresh team page hides nothing if its
 * members are 3 days stale.
 */
export function oldestSyncAgeSeconds(
  nodes: ReadonlyArray<{ data: Record<string, unknown> }>,
): number | undefined {
  let max: number | undefined;
  for (const n of nodes) {
    const v = asNumber(n.data['_last_synced_age_seconds']);
    if (v === undefined) continue;
    if (max === undefined || v > max) max = v;
  }
  return max;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety verdict
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the change-risk verdict for the safety panel.
 *
 * The user picked the bold UX (an explicit severity level, not just raw
 * facts). The mitigation required by the design review: always return the
 * *reasons* alongside the level so the IC can see the inputs that drove
 * the recommendation. The panel additionally shows a claim-conflict
 * warning when tier metadata is contested — that signal comes from the
 * claims API, not from this function.
 *
 * Rules (intentionally conservative — over-warn beats under-warn):
 *   - CRITICAL : tier 1 OR ≥1 T1 dependents downstream
 *   - ELEVATED : tier 2 OR ≥5 total downstream OR PII flag
 *   - LOW      : tier 3 AND zero downstream AND lifecycle is
 *                experimental/deprecated/decommissioned
 *   - default  : ELEVATED — "When in doubt, coordinate."
 *
 * Internal level keys remain `red`/`yellow`/`green` so existing tests and
 * the tone-mapping table don't have to change; the user-facing labels
 * (`label` field below, plus LEVEL_TONE in the verdict component) carry
 * the severity terminology.
 */
export function safetyVerdict(
  service: ServiceNode | undefined,
  blast: BlastRadiusEntry[],
): SafetyVerdict {
  if (!service) {
    return { level: 'unknown', label: 'Service not in catalog', reasons: [] };
  }

  const summary = blastRadiusSummary(blast);
  const tier = service.tier;
  const lifecycle = service.lifecycle?.toLowerCase();
  const reasons: string[] = [];
  if (tier !== undefined) reasons.push(`Tier T${tier}`);
  if (lifecycle) reasons.push(`Lifecycle: ${lifecycle}`);
  reasons.push(`${summary.total} downstream service${summary.total === 1 ? '' : 's'}`);
  if (summary.tier1 > 0)
    reasons.push(`${summary.tier1} T1 dependent${summary.tier1 === 1 ? '' : 's'}`);
  if (service.hasPii) reasons.push('Service flagged for PII');

  // CRITICAL
  if (tier === 1 || summary.tier1 > 0) {
    return { level: 'red', label: 'Critical', reasons };
  }
  // LOW — must satisfy all conditions
  if (
    tier === 3 &&
    summary.total === 0 &&
    (lifecycle === 'experimental' || lifecycle === 'deprecated' || lifecycle === 'decommissioned')
  ) {
    return { level: 'green', label: 'Low', reasons };
  }
  // ELEVATED
  if (tier === 2 || summary.total >= 5 || service.hasPii) {
    return { level: 'yellow', label: 'Elevated', reasons };
  }
  // Default — stay cautious.
  return { level: 'yellow', label: 'Elevated', reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Property keys that the UI uses to detect tier/lifecycle conflicts.
// (Read by the safety-verdict panel via fetchEntityClaims.)
// ─────────────────────────────────────────────────────────────────────────────
export const VERDICT_INPUT_PROPERTY_KEYS = ['tier', 'lifecycle', 'contains_pii'] as const;
