import type { V1Namespace } from '@kubernetes/client-node';
import { KubernetesError } from '../auth.js';
import type { NamespaceRef } from '../types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const PAGE_LIMIT = 500;

/** Per-call timeout; the API client has none of its own that we control. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new KubernetesError('TIMEOUT', `${what} exceeded ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Namespace scope: any include glob must match and no exclude glob may match. */
export function matchesScope(name: string, include: string[], exclude: string[]): boolean {
  if (!include.some((g) => globToRegExp(g).test(name))) return false;
  return !exclude.some((g) => globToRegExp(g).test(name));
}

export function toNamespaceRef(ns: V1Namespace): NamespaceRef {
  return {
    name: ns.metadata?.name ?? '',
    labels: ns.metadata?.labels ?? {},
    annotations: ns.metadata?.annotations ?? {},
  };
}
