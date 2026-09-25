import type {
  V1CronJobList,
  V1DaemonSetList,
  V1DeploymentList,
  V1OwnerReference,
  V1Pod,
  V1ReplicaSet,
  V1StatefulSetList,
} from '@kubernetes/client-node';
import type { FetchResult } from '@shipit-ai/connector-sdk';
import { classifyError, type KubeClients } from '../auth.js';
import type {
  NamespaceRef,
  PodSummary,
  RawWorkload,
  WorkloadKind,
  WorkloadObject,
} from '../types.js';
import { DEFAULT_TIMEOUT_MS, PAGE_LIMIT, abortable, withTimeout } from './common.js';

interface NamespaceCache {
  pods: V1Pod[];
  replicaSets: V1ReplicaSet[];
}

interface Position {
  nsIndex: number;
  kindIndex: number;
}

/**
 * Cursor = JSON [nsIndex, kindIndex, continueToken]; K8s continue tokens are
 * opaque. Exported so a caller that wants exactly one (namespace, kind) page —
 * the connection probe — can address a slot without owning the encoding.
 */
export function encodeCursor(nsIndex: number, kindIndex: number, continueToken?: string): string {
  return JSON.stringify([nsIndex, kindIndex, continueToken ?? null]);
}

/** Non-integer, negative or out-of-range → the nearest valid slot, never NaN. */
function clampIndex(value: unknown, count: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const i = Math.trunc(value);
  if (i < 0) return 0;
  // `count` may be 0 for nsIndex on an empty namespace list; fetch() early-returns.
  return count > 0 && i >= count ? count - 1 : i;
}

/**
 * A cursor survives a config change: shrinking `scope.kinds` mid-run leaves a
 * `kindIndex` past the end, which used to reach `listKind` with
 * `kind === undefined` and throw a raw TypeError instead of a KubernetesError.
 */
function decodeCursor(
  cursor: string | undefined,
  nsCount: number,
  kindCount: number,
): Position & { continueToken?: string } {
  if (!cursor) return { nsIndex: 0, kindIndex: 0 };
  const [nsIndex, kindIndex, continueToken] = JSON.parse(cursor) as [number, number, string | null];
  return {
    nsIndex: clampIndex(nsIndex, nsCount),
    kindIndex: clampIndex(kindIndex, kindCount),
    continueToken: typeof continueToken === 'string' ? continueToken : undefined,
  };
}

function advance(pos: Position, kindCount: number): Position {
  return pos.kindIndex + 1 < kindCount
    ? { nsIndex: pos.nsIndex, kindIndex: pos.kindIndex + 1 }
    : { nsIndex: pos.nsIndex + 1, kindIndex: 0 };
}

export function digestFromImageId(imageId: string | undefined): string | undefined {
  if (!imageId) return undefined;
  const at = imageId.lastIndexOf('@');
  if (at === -1) return undefined;
  const digest = imageId.slice(at + 1);
  return /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : undefined;
}

function ownedBy(refs: V1OwnerReference[] | undefined, kind: string, name: string): boolean {
  return (refs ?? []).some((o) => o.kind === kind && o.name === name);
}

const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';

/**
 * Of a Deployment's owned ReplicaSets, the one(s) at the highest numeric
 * `deployment.kubernetes.io/revision` — the current rollout target. `null`
 * when none carry a parseable revision, so callers fall back to "all owned".
 */
function newestRevisionReplicaSets(replicaSets: V1ReplicaSet[]): V1ReplicaSet[] | null {
  let maxRevision: number | undefined;
  const withRevision: Array<{ rs: V1ReplicaSet; revision: number }> = [];
  for (const rs of replicaSets) {
    const raw = rs.metadata?.annotations?.[REVISION_ANNOTATION];
    if (raw === undefined) continue;
    const revision = Number(raw);
    if (!Number.isFinite(revision)) continue;
    withRevision.push({ rs, revision });
    if (maxRevision === undefined || revision > maxRevision) maxRevision = revision;
  }
  if (maxRevision === undefined) return null;
  return withRevision.filter((r) => r.revision === maxRevision).map((r) => r.rs);
}

function podsOwnedByReplicaSets(pods: V1Pod[], rsNames: Set<string>): V1Pod[] {
  return pods.filter((p) =>
    (p.metadata?.ownerReferences ?? []).some((o) => o.kind === 'ReplicaSet' && rsNames.has(o.name)),
  );
}

/** Roll a namespace's pods up to one workload. Deployment → ReplicaSet → Pod; others own pods directly. */
export function summarizePods(
  kind: WorkloadKind,
  object: WorkloadObject,
  cache: NamespaceCache | null,
): PodSummary {
  // Counters stay undefined until we know a rollup can run: an un-measured
  // workload must not report zeros that read as measured fact.
  const summary: PodSummary = { imageDigests: {} };
  if (!cache || kind === 'CronJob') return summary;
  summary.readyPods = 0;
  summary.restarts = 0;
  const name = object.metadata?.name ?? '';
  let owned: V1Pod[];
  let digestPods: V1Pod[];
  if (kind === 'Deployment') {
    const ownedReplicaSets = cache.replicaSets.filter((rs) =>
      ownedBy(rs.metadata?.ownerReferences, 'Deployment', name),
    );
    const rsNames = new Set(ownedReplicaSets.map((rs) => rs.metadata?.name ?? ''));
    owned = podsOwnedByReplicaSets(cache.pods, rsNames);
    // readyPods/restarts count every owned pod (old + new revisions mid-rollout);
    // image digests are attributed only to the newest revision's pods so a
    // rolling update never stamps the new tag with the old digest.
    const newest = newestRevisionReplicaSets(ownedReplicaSets);
    const digestRsNames = newest ? new Set(newest.map((rs) => rs.metadata?.name ?? '')) : rsNames;
    digestPods = podsOwnedByReplicaSets(cache.pods, digestRsNames);
  } else {
    owned = cache.pods.filter((p) => ownedBy(p.metadata?.ownerReferences, kind, name));
    digestPods = owned;
  }
  for (const pod of owned) {
    if ((pod.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'))
      summary.readyPods! += 1;
    for (const cs of pod.status?.containerStatuses ?? []) {
      summary.restarts! += cs.restartCount ?? 0;
    }
  }
  // Collect every digest seen per container among the digest-eligible pods;
  // a container with more than one distinct digest is ambiguous (e.g. pods
  // of the "newest" ReplicaSet still transitioning) and is omitted entirely.
  const seen = new Map<string, Set<string>>();
  for (const pod of digestPods) {
    for (const cs of pod.status?.containerStatuses ?? []) {
      const digest = digestFromImageId(cs.imageID);
      if (!digest) continue;
      const digests = seen.get(cs.name) ?? new Set<string>();
      digests.add(digest);
      seen.set(cs.name, digests);
    }
  }
  for (const [container, digests] of seen) {
    if (digests.size === 1) summary.imageDigests[container] = [...digests][0];
  }
  return summary;
}

/**
 * Stateful pager over (namespace × kind). Lists pods + ReplicaSets once per
 * namespace and matches in memory. A 403 on one kind records a warning and
 * skips that kind for every namespace; any other failure propagates classified.
 */
export class WorkloadFetcher {
  private readonly cache = new Map<string, NamespaceCache>();
  private readonly forbiddenKinds = new Set<WorkloadKind>();
  private rollupsForbidden = false;
  readonly warnings: string[] = [];

  constructor(
    private readonly clients: KubeClients,
    private readonly namespaces: NamespaceRef[],
    private readonly kinds: WorkloadKind[],
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async fetch(cursor?: string): Promise<FetchResult> {
    let pos: Position & { continueToken?: string } = decodeCursor(
      cursor,
      this.namespaces.length,
      this.kinds.length,
    );
    while (
      pos.nsIndex < this.namespaces.length &&
      this.forbiddenKinds.has(this.kinds[pos.kindIndex])
    ) {
      pos = advance(pos, this.kinds.length);
    }
    if (pos.nsIndex >= this.namespaces.length) return { entities: [], has_more: false };

    const ns = this.namespaces[pos.nsIndex];
    const kind = this.kinds[pos.kindIndex];
    let page: { items: WorkloadObject[]; continueToken?: string };
    try {
      page = await this.listKind(ns.name, kind, pos.continueToken);
    } catch (err) {
      const classified = classifyError(err);
      if (classified.code === 'FORBIDDEN') {
        this.forbiddenKinds.add(kind);
        this.warnings.push(
          `FORBIDDEN:${kind} — listing ${kind} in namespace "${ns.name}" was denied; grant list on ${kind.toLowerCase()}s to the ShipIt ServiceAccount`,
        );
        return this.emptyPage(advance(pos, this.kinds.length));
      }
      throw classified;
    }

    const cache = kind === 'CronJob' ? null : await this.namespaceCache(ns.name);
    const entities: RawWorkload[] = page.items.map((object) => ({
      __shipit: 'workload',
      kind,
      object,
      namespace: ns,
      pods: summarizePods(kind, object, cache),
    }));
    if (page.continueToken) {
      return {
        entities,
        cursor: encodeCursor(pos.nsIndex, pos.kindIndex, page.continueToken),
        has_more: true,
      };
    }
    const next = advance(pos, this.kinds.length);
    const done = next.nsIndex >= this.namespaces.length;
    return {
      entities,
      cursor: done ? undefined : encodeCursor(next.nsIndex, next.kindIndex),
      has_more: !done,
    };
  }

  /** Refetch seam: exactly one workload of `kinds[0]` in `namespaces[0]` by name. */
  async fetchOne(name: string): Promise<RawWorkload | null> {
    const ns = this.namespaces[0];
    const kind = this.kinds[0];
    const page = await this.listKind(ns.name, kind, undefined, `metadata.name=${name}`);
    const object = page.items[0];
    if (!object) return null;
    const cache = kind === 'CronJob' ? null : await this.namespaceCache(ns.name);
    return {
      __shipit: 'workload',
      kind,
      object,
      namespace: ns,
      pods: summarizePods(kind, object, cache),
    };
  }

  private emptyPage(next: Position): FetchResult {
    const done = next.nsIndex >= this.namespaces.length;
    return {
      entities: [],
      cursor: done ? undefined : encodeCursor(next.nsIndex, next.kindIndex),
      has_more: !done,
    };
  }

  private async listKind(
    namespace: string,
    kind: WorkloadKind,
    continueToken?: string,
    fieldSelector?: string,
  ): Promise<{ items: WorkloadObject[]; continueToken?: string }> {
    const param = { namespace, limit: PAGE_LIMIT, _continue: continueToken, fieldSelector };
    const what = `list ${kind} in ${namespace}`;
    const call = (
      signal: AbortSignal,
    ): Promise<V1DeploymentList | V1StatefulSetList | V1DaemonSetList | V1CronJobList> => {
      const opts = abortable(signal);
      switch (kind) {
        case 'Deployment':
          return this.clients.apps.listNamespacedDeployment(param, opts);
        case 'StatefulSet':
          return this.clients.apps.listNamespacedStatefulSet(param, opts);
        case 'DaemonSet':
          return this.clients.apps.listNamespacedDaemonSet(param, opts);
        case 'CronJob':
          return this.clients.batch.listNamespacedCronJob(param, opts);
      }
    };
    const list = await withTimeout(call, this.timeoutMs, what);
    return {
      items: list.items as WorkloadObject[],
      continueToken: list.metadata?._continue || undefined,
    };
  }

  private async namespaceCache(namespace: string): Promise<NamespaceCache> {
    const hit = this.cache.get(namespace);
    if (hit) return hit;
    // A cluster-wide RBAC gap on pods/replicasets would otherwise re-issue
    // both list calls and re-warn for every namespace; once denied, skip the
    // API entirely and hand back an empty rollup for the rest of this run.
    if (this.rollupsForbidden) return { pods: [], replicaSets: [] };
    const [pods, replicaSets] = await Promise.all([
      this.listAll<V1Pod>(
        (c, signal) =>
          this.clients.core.listNamespacedPod(
            { namespace, limit: PAGE_LIMIT, _continue: c },
            abortable(signal),
          ),
        `list pods in ${namespace}`,
      ),
      this.listAll<V1ReplicaSet>(
        (c, signal) =>
          this.clients.apps.listNamespacedReplicaSet(
            { namespace, limit: PAGE_LIMIT, _continue: c },
            abortable(signal),
          ),
        `list replicasets in ${namespace}`,
      ),
    ]);
    const entry = { pods, replicaSets };
    // advance() only ever moves forward through namespaces, so an earlier
    // namespace's pods/ReplicaSets are dead weight — on a large cluster that is
    // every pod object of the run held for the whole run.
    this.cache.clear();
    this.cache.set(namespace, entry);
    return entry;
  }

  private async listAll<T>(
    page: (
      continueToken: string | undefined,
      signal: AbortSignal,
    ) => Promise<{ items: T[]; metadata?: { _continue?: string } }>,
    what: string,
  ): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    do {
      let list: { items: T[]; metadata?: { _continue?: string } };
      try {
        list = await withTimeout((signal) => page(token, signal), this.timeoutMs, what);
      } catch (err) {
        const classified = classifyError(err);
        if (classified.code === 'FORBIDDEN') {
          if (!this.rollupsForbidden) {
            this.rollupsForbidden = true;
            this.warnings.push(
              'FORBIDDEN:pods — pod/replicaset rollups (ready counts, restarts, digests) disabled; grant list on pods and replicasets to the ShipIt ServiceAccount',
            );
          }
          return out;
        }
        throw classified;
      }
      out.push(...list.items);
      token = list.metadata?._continue || undefined;
    } while (token);
    return out;
  }
}
