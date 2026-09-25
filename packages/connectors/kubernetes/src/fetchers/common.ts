import { Observable, type ConfigurationOptions, type V1Namespace } from '@kubernetes/client-node';
import { KubernetesError } from '../auth.js';
import type { NamespaceRef } from '../types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const PAGE_LIMIT = 500;

/**
 * Per-call timeout; the API client has none of its own that we control.
 *
 * The deadline CANCELS the call rather than merely stopping the wait: `call`
 * receives an AbortSignal that is aborted when the timer fires. Racing a timer
 * against an un-abortable promise left the request running and holding its
 * socket long after we had given up on it — on a 5-minute poll against a slow
 * API server those leak faster than they drain.
 */
export async function withTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new KubernetesError('TIMEOUT', `${what} exceeded ${ms} ms`);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([call(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Request options that carry an AbortSignal into a generated client call.
 * `RequestContext.setSignal` is the only seam client-node exposes for this, and
 * it is reachable only from a `pre` middleware — hence the wrapper. Middleware
 * is appended so the client's own auth middleware still runs.
 */
export function abortable(signal: AbortSignal): ConfigurationOptions {
  return {
    middleware: [
      {
        pre: (context) => {
          context.setSignal(signal);
          return new Observable(Promise.resolve(context));
        },
        post: (context) => new Observable(Promise.resolve(context)),
      },
    ],
    middlewareMergeStrategy: 'append',
  };
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
