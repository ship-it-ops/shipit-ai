import { existsSync } from 'node:fs';
import {
  ApiException,
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  VersionApi,
} from '@kubernetes/client-node';
import { parse as parseYaml } from 'yaml';

export type KubernetesErrorCode =
  | 'IN_CLUSTER_UNAVAILABLE'
  | 'UNSUPPORTED_AUTH_PLUGIN'
  | 'KUBECONFIG_INVALID'
  | 'API_UNREACHABLE'
  | 'TLS_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NAMESPACE_SCOPE_EMPTY'
  | 'TIMEOUT'
  | 'API_ERROR';

/** Structured connector error. `message` always starts with the code so it is
 *  actionable in run history; `status` lets the SDK harness sniff 401/403. */
export class KubernetesError extends Error {
  readonly code: KubernetesErrorCode;
  readonly status?: number;
  constructor(code: KubernetesErrorCode, message: string, status?: number) {
    super(`${code}: ${message}`);
    this.name = 'KubernetesError';
    this.code = code;
    this.status = status;
  }
}

export type KubernetesAccessCredentials =
  | { mode: 'in-cluster' }
  | { mode: 'kubeconfig'; kubeconfig: string; context?: string }
  | { mode: 'token'; server: string; token: string; caData?: string }; // caData: base64 PEM

/** `ConnectorConfig.credentials` → typed credentials (the factory fills the map, Task 11). */
export function parseCredentials(raw: Record<string, string>): KubernetesAccessCredentials {
  switch (raw.mode) {
    case 'in-cluster':
      return { mode: 'in-cluster' };
    case 'kubeconfig':
      if (!raw.kubeconfig) {
        throw new KubernetesError(
          'KUBECONFIG_INVALID',
          'credentials.kubeconfig is required for mode kubeconfig',
        );
      }
      return { mode: 'kubeconfig', kubeconfig: raw.kubeconfig, context: raw.context || undefined };
    case 'token':
      if (!raw.server || !raw.token) {
        throw new KubernetesError(
          'KUBECONFIG_INVALID',
          'credentials.server and credentials.token are required for mode token',
        );
      }
      return {
        mode: 'token',
        server: raw.server,
        token: raw.token,
        caData: raw.caData || undefined,
      };
    default:
      throw new KubernetesError('KUBECONFIG_INVALID', `unknown access mode "${raw.mode ?? ''}"`);
  }
}

export const SERVICE_ACCOUNT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

/** Injection seam so tests can simulate a pod without touching the real filesystem. */
export interface InClusterProbe {
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
}
const defaultProbe: InClusterProbe = { env: process.env, fileExists: existsSync };

/** Allowlisted shape fed straight to `KubeConfig#loadFromOptions`; nothing on
 *  this type can reference the filesystem or an external process. */
export interface KubeconfigOptions {
  clusters: Array<{
    name: string;
    server: string;
    caData?: string;
    tlsServerName?: string;
    skipTLSVerify: false;
  }>;
  users: Array<{
    name: string;
    token?: string;
    certData?: string;
    keyData?: string;
    username?: string;
    password?: string;
  }>;
  contexts: Array<{ name: string; cluster: string; user: string; namespace?: string }>;
  currentContext: string;
}

export type KubeconfigValidation =
  | { ok: true; contexts: string[]; currentContext: string; options: KubeconfigOptions }
  | { ok: false; code: 'KUBECONFIG_INVALID' | 'UNSUPPORTED_AUTH_PLUGIN'; message: string };

const FILE_REFERENCE_MESSAGE =
  'file references (token-file, certificate-authority, client-certificate, client-key) are not allowed; inline the *-data fields instead';
const AUTH_PLUGIN_MESSAGE =
  'kubeconfig user relies on an exec/auth-provider plugin, which cannot run inside ShipIt; paste a ServiceAccount token instead';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface NamedEntry {
  name: string;
  inner: Record<string, unknown>;
}

/** `clusters`/`users`/`contexts` all share the `[{ name, <key>: {...} }]` shape. */
function parseNamedList(
  root: Record<string, unknown>,
  listKey: string,
  innerKey: string,
): NamedEntry[] | null {
  const list = root[listKey];
  if (!Array.isArray(list)) return null;
  const out: NamedEntry[] = [];
  for (const entry of list) {
    if (!isPlainObject(entry)) return null;
    const name = entry.name;
    const inner = entry[innerKey];
    if (typeof name !== 'string' || !isPlainObject(inner)) return null;
    out.push({ name, inner });
  }
  return out;
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Spec §Access modes: exactly one context (or an explicit one); no exec /
 * auth-provider plugins (the binary is not in the pod); no file references
 * (nothing else is mounted); no insecure-skip-tls-verify.
 *
 * client-node's own kubeconfig loader is never used on user-supplied text:
 * its `findToken()` reads `user['token-file']` off the filesystem DURING
 * parsing, before any validation runs, and would follow the reference
 * however it is spelled (block/flow style, quoted or unquoted key). We parse
 * the YAML ourselves, validate every cluster/user/context entry structurally,
 * and only ever hand `KubeConfig` an allowlisted, already-inlined result via
 * `loadFromOptions` (see `KubeconfigOptions`).
 */
export function validateKubeconfigText(text: string, context?: string): KubeconfigValidation {
  let parsed: unknown;
  try {
    // logLevel 'silent': the yaml package's default ('warn') calls
    // process.emitWarning with a source snippet for e.g. an unresolved tag —
    // which would print a bearer token straight to stderr on a "valid" parse.
    parsed = parseYaml(text, { logLevel: 'silent' });
  } catch (err) {
    const e = err as { name?: string; linePos?: Array<{ line?: number }> };
    const line = e.linePos?.[0]?.line;
    const where = typeof line === 'number' ? ` (line ${line})` : '';
    const reason = typeof e.name === 'string' && e.name ? e.name : 'YAMLParseError';
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: `kubeconfig does not parse: ${reason}${where}`,
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: 'KUBECONFIG_INVALID', message: 'kubeconfig root must be a mapping' };
  }

  const clusters = parseNamedList(parsed, 'clusters', 'cluster');
  const users = parseNamedList(parsed, 'users', 'user');
  const contexts = parseNamedList(parsed, 'contexts', 'context');
  if (!clusters || !users || !contexts) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message:
        'kubeconfig must have clusters, users and contexts arrays of { name, cluster|user|context }',
    };
  }

  // Forbidden keys are checked on every entry, not just the selected
  // context: an unselected user/cluster is still attacker-controlled input.
  for (const { inner: cluster } of clusters) {
    if ('certificate-authority' in cluster) {
      return { ok: false, code: 'KUBECONFIG_INVALID', message: FILE_REFERENCE_MESSAGE };
    }
    if (cluster['insecure-skip-tls-verify']) {
      return {
        ok: false,
        code: 'KUBECONFIG_INVALID',
        message: 'insecure-skip-tls-verify is not allowed; supply certificate-authority-data',
      };
    }
  }
  for (const { inner: user } of users) {
    if ('exec' in user || 'auth-provider' in user) {
      return { ok: false, code: 'UNSUPPORTED_AUTH_PLUGIN', message: AUTH_PLUGIN_MESSAGE };
    }
    if ('token-file' in user || 'client-certificate' in user || 'client-key' in user) {
      return { ok: false, code: 'KUBECONFIG_INVALID', message: FILE_REFERENCE_MESSAGE };
    }
  }

  const contextNames = contexts.map((c) => c.name);
  let currentContext: string;
  if (context) {
    if (!contextNames.includes(context)) {
      return {
        ok: false,
        code: 'KUBECONFIG_INVALID',
        message: `context "${context}" not found (have: ${contextNames.join(', ') || 'none'})`,
      };
    }
    currentContext = context;
  } else if (contextNames.length !== 1) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message:
        contextNames.length === 0
          ? 'kubeconfig has no contexts'
          : `kubeconfig has ${contextNames.length} contexts; pass "context" to pick one`,
    };
  } else {
    currentContext = contextNames[0];
  }

  const selected = contexts.find((c) => c.name === currentContext)!;
  const clusterName = asString(selected.inner.cluster);
  const userName = asString(selected.inner.user);
  const selectedCluster = clusterName ? clusters.find((c) => c.name === clusterName) : undefined;
  const selectedUser = userName ? users.find((u) => u.name === userName) : undefined;
  if (!selectedCluster) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: `context "${currentContext}" references unknown cluster "${clusterName ?? ''}"`,
    };
  }
  if (!selectedUser) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: `context "${currentContext}" references unknown user "${userName ?? ''}"`,
    };
  }
  if (!asString(selectedCluster.inner.server)) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: 'current context has no cluster.server',
    };
  }
  const u = selectedUser.inner;
  const hasToken = Boolean(asString(u.token));
  const hasCert = Boolean(asString(u['client-certificate-data']) && asString(u['client-key-data']));
  const hasBasicAuth = Boolean(asString(u.username) && asString(u.password));
  if (!hasToken && !hasCert && !hasBasicAuth) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: 'kubeconfig user carries no token, client certificate or basic-auth credentials',
    };
  }

  const options: KubeconfigOptions = {
    clusters: clusters.map((c) => ({
      name: c.name,
      server: asString(c.inner.server) ?? '',
      caData: asString(c.inner['certificate-authority-data']),
      tlsServerName: asString(c.inner['tls-server-name']),
      skipTLSVerify: false,
    })),
    users: users.map((usr) => ({
      name: usr.name,
      token: asString(usr.inner.token),
      certData: asString(usr.inner['client-certificate-data']),
      keyData: asString(usr.inner['client-key-data']),
      username: asString(usr.inner.username),
      password: asString(usr.inner.password),
    })),
    contexts: contexts.map((c) => ({
      name: c.name,
      cluster: asString(c.inner.cluster) ?? '',
      user: asString(c.inner.user) ?? '',
      namespace: asString(c.inner.namespace),
    })),
    currentContext,
  };

  return { ok: true, contexts: contextNames, currentContext, options };
}

export function buildKubeConfig(
  creds: KubernetesAccessCredentials,
  probe: InClusterProbe = defaultProbe,
): KubeConfig {
  const kc = new KubeConfig();
  switch (creds.mode) {
    case 'in-cluster': {
      if (!probe.env.KUBERNETES_SERVICE_HOST || !probe.fileExists(SERVICE_ACCOUNT_TOKEN_PATH)) {
        throw new KubernetesError(
          'IN_CLUSTER_UNAVAILABLE',
          'no in-cluster ServiceAccount token found (KUBERNETES_SERVICE_HOST unset or token file missing); use kubeconfig or token access instead',
        );
      }
      // client-node reads KUBERNETES_SERVICE_HOST/PORT from process.env itself;
      // the probe only decides whether we are allowed to try.
      kc.loadFromCluster();
      return kc;
    }
    case 'kubeconfig': {
      const v = validateKubeconfigText(creds.kubeconfig, creds.context);
      if (!v.ok) throw new KubernetesError(v.code, v.message);
      // Only the allowlisted `options` (never the raw text) reach KubeConfig.
      kc.loadFromOptions(v.options);
      return kc;
    }
    case 'token': {
      kc.loadFromOptions({
        clusters: [
          { name: 'cluster', server: creds.server, caData: creds.caData, skipTLSVerify: false },
        ],
        users: [{ name: 'user', token: creds.token }],
        contexts: [{ name: 'ctx', cluster: 'cluster', user: 'user' }],
        currentContext: 'ctx',
      });
      return kc;
    }
  }
}

/** The subset of the generated clients the connector uses; fakes implement exactly this. */
export interface KubeClients {
  core: Pick<CoreV1Api, 'listNamespace' | 'readNamespace' | 'listNode' | 'listNamespacedPod'>;
  apps: Pick<
    AppsV1Api,
    | 'listNamespacedDeployment'
    | 'listNamespacedStatefulSet'
    | 'listNamespacedDaemonSet'
    | 'listNamespacedReplicaSet'
  >;
  batch: Pick<BatchV1Api, 'listNamespacedCronJob'>;
  version: Pick<VersionApi, 'getCode'>;
}

export type ClientFactory = (kc: KubeConfig) => KubeClients;

export const defaultClientFactory: ClientFactory = (kc) => ({
  core: kc.makeApiClient(CoreV1Api),
  apps: kc.makeApiClient(AppsV1Api),
  batch: kc.makeApiClient(BatchV1Api),
  version: kc.makeApiClient(VersionApi),
});

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EAI_AGAIN',
  'EPIPE',
]);
const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** Spec §Error handling: every failure becomes a `KubernetesError` with a stable code. */
export function classifyError(err: unknown): KubernetesError {
  if (err instanceof KubernetesError) return err;
  if (err instanceof ApiException) {
    const status = err.code;
    if (status === 401)
      return new KubernetesError(
        'UNAUTHORIZED',
        'the API server rejected the credentials (401)',
        401,
      );
    // ApiException#message concatenates the raw HTTP status line, body and
    // headers (which may carry Set-Cookie behind an auth proxy); only the
    // body's own `message` field, if present, is safe to surface.
    const bodyMessage = (err.body as { message?: unknown } | undefined)?.message;
    const summary = (
      typeof bodyMessage === 'string' && bodyMessage ? bodyMessage : `HTTP ${status}`
    ).slice(0, 200);
    if (status === 403)
      return new KubernetesError('FORBIDDEN', `permission denied (403): ${summary}`, 403);
    return new KubernetesError('API_ERROR', `API server returned ${status}: ${summary}`, status);
  }
  const e = err as
    | {
        code?: string;
        message?: string;
        name?: string;
        cause?: { code?: string; message?: string };
      }
    | undefined;
  const code = e?.cause?.code ?? e?.code ?? '';
  const message = e?.cause?.message ?? e?.message ?? String(err);
  if (e?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new KubernetesError('TIMEOUT', message);
  }
  if (NETWORK_CODES.has(code)) return new KubernetesError('API_UNREACHABLE', `${code}: ${message}`);
  if (TLS_CODES.has(code) || /certificate|tls|ssl/i.test(message))
    return new KubernetesError('TLS_ERROR', message);
  return new KubernetesError('API_ERROR', message);
}
