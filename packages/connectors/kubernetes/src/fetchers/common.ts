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

/**
 * Compile a namespace scope once, then test many names against it: a page of
 * namespaces would otherwise recompile every glob for every name.
 */
export function compileScope(include: string[], exclude: string[]): (name: string) => boolean {
  const includeRe = include.map(globToRegExp);
  const excludeRe = exclude.map(globToRegExp);
  return (name: string) =>
    includeRe.some((re) => re.test(name)) && !excludeRe.some((re) => re.test(name));
}

/** Namespace scope: any include glob must match and no exclude glob may match. */
export function matchesScope(name: string, include: string[], exclude: string[]): boolean {
  return compileScope(include, exclude)(name);
}

export function toNamespaceRef(ns: V1Namespace): NamespaceRef {
  return {
    name: ns.metadata?.name ?? '',
    labels: ns.metadata?.labels ?? {},
    annotations: ns.metadata?.annotations ?? {},
  };
}
