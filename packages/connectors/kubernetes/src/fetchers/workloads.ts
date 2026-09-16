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
import { DEFAULT_TIMEOUT_MS, PAGE_LIMIT, withTimeout } from './common.js';

interface NamespaceCache {
  pods: V1Pod[];
  replicaSets: V1ReplicaSet[];
}

interface Position {
  nsIndex: number;
  kindIndex: number;
}

// Cursor = JSON [nsIndex, kindIndex, continueToken]; K8s continue tokens are opaque.
function encodeCursor(nsIndex: number, kindIndex: number, continueToken?: string): string {
  return JSON.stringify([nsIndex, kindIndex, continueToken ?? null]);
}

function decodeCursor(cursor: string | undefined): Position & { continueToken?: string } {
  if (!cursor) return { nsIndex: 0, kindIndex: 0 };
  const [nsIndex, kindIndex, continueToken] = JSON.parse(cursor) as [number, number, string | null];
  return { nsIndex, kindIndex, continueToken: continueToken ?? undefined };
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

/** Roll a namespace's pods up to one workload. Deployment → ReplicaSet → Pod; others own pods directly. */
export function summarizePods(
  kind: WorkloadKind,
  object: WorkloadObject,
  cache: NamespaceCache | null,
): PodSummary {
  const summary: PodSummary = { readyPods: 0, restarts: 0, imageDigests: {} };
  if (!cache || kind === 'CronJob') return summary;
  const name = object.metadata?.name ?? '';
  let owned: V1Pod[];
  if (kind === 'Deployment') {
    const rsNames = new Set(
      cache.replicaSets
        .filter((rs) => ownedBy(rs.metadata?.ownerReferences, 'Deployment', name))
        .map((rs) => rs.metadata?.name ?? ''),
    );
    owned = cache.pods.filter((p) =>
      (p.metadata?.ownerReferences ?? []).some(
        (o) => o.kind === 'ReplicaSet' && rsNames.has(o.name),
      ),
    );
  } else {
    owned = cache.pods.filter((p) => ownedBy(p.metadata?.ownerReferences, kind, name));
  }
  for (const pod of owned) {
    if ((pod.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'))
      summary.readyPods++;
    for (const cs of pod.status?.containerStatuses ?? []) {
      summary.restarts += cs.restartCount ?? 0;
      const digest = digestFromImageId(cs.imageID);
      if (digest && !summary.imageDigests[cs.name]) summary.imageDigests[cs.name] = digest;
    }
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
  readonly warnings: string[] = [];

  constructor(
    private readonly clients: KubeClients,
    private readonly namespaces: NamespaceRef[],
    private readonly kinds: WorkloadKind[],
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async fetch(cursor?: string): Promise<FetchResult> {
    let pos: Position & { continueToken?: string } = decodeCursor(cursor);
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
    const call = (): Promise<
      V1DeploymentList | V1StatefulSetList | V1DaemonSetList | V1CronJobList
    > => {
      switch (kind) {
        case 'Deployment':
          return this.clients.apps.listNamespacedDeployment(param);
        case 'StatefulSet':
          return this.clients.apps.listNamespacedStatefulSet(param);
        case 'DaemonSet':
          return this.clients.apps.listNamespacedDaemonSet(param);
        case 'CronJob':
          return this.clients.batch.listNamespacedCronJob(param);
      }
    };
    const list = await withTimeout(call(), this.timeoutMs, what);
    return {
      items: list.items as WorkloadObject[],
      continueToken: list.metadata?._continue || undefined,
    };
  }

  private async namespaceCache(namespace: string): Promise<NamespaceCache> {
    const hit = this.cache.get(namespace);
    if (hit) return hit;
    const [pods, replicaSets] = await Promise.all([
      this.listAll<V1Pod>(
        (c) => this.clients.core.listNamespacedPod({ namespace, limit: PAGE_LIMIT, _continue: c }),
        `list pods in ${namespace}`,
      ),
      this.listAll<V1ReplicaSet>(
        (c) =>
          this.clients.apps.listNamespacedReplicaSet({
            namespace,
            limit: PAGE_LIMIT,
            _continue: c,
          }),
        `list replicasets in ${namespace}`,
      ),
    ]);
    const entry = { pods, replicaSets };
    this.cache.set(namespace, entry);
    return entry;
  }

  private async listAll<T>(
    page: (continueToken?: string) => Promise<{ items: T[]; metadata?: { _continue?: string } }>,
    what: string,
  ): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    do {
      let list: { items: T[]; metadata?: { _continue?: string } };
      try {
        list = await withTimeout(page(token), this.timeoutMs, what);
      } catch (err) {
        const classified = classifyError(err);
        if (classified.code === 'FORBIDDEN') {
          this.warnings.push(
            `FORBIDDEN:${what} — pod/replicaset rollups (ready counts, restarts, digests) disabled for this namespace`,
          );
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
