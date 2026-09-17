import type { KubeClients } from '../auth.js';
import type { NamespaceRef, RawNamespace } from '../types.js';
import {
  DEFAULT_TIMEOUT_MS,
  PAGE_LIMIT,
  compileScope,
  toNamespaceRef,
  withTimeout,
} from './common.js';

export interface NamespacePage {
  entities: RawNamespace[];
  refs: NamespaceRef[];
  cursor?: string;
  has_more: boolean;
}

export async function fetchNamespaces(
  clients: KubeClients,
  scope: { include: string[]; exclude: string[] },
  cursor: string | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<NamespacePage> {
  const list = await withTimeout(
    clients.core.listNamespace({ limit: PAGE_LIMIT, _continue: cursor }),
    timeoutMs,
    'list namespaces',
  );
  const inScope = compileScope(scope.include, scope.exclude);
  const items = list.items.filter((ns) => inScope(ns.metadata?.name ?? ''));
  const next = list.metadata?._continue || undefined;
  return {
    entities: items.map((object) => ({ __shipit: 'namespace', object })),
    refs: items.map(toNamespaceRef),
    cursor: next,
    has_more: Boolean(next),
  };
}

export async function fetchNamespaceRef(
  clients: KubeClients,
  name: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<NamespaceRef> {
  const ns = await withTimeout(
    clients.core.readNamespace({ name }),
    timeoutMs,
    `get namespace ${name}`,
  );
  return toNamespaceRef(ns);
}
