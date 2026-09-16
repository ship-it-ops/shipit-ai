import { existsSync } from 'node:fs';
import {
  ApiException,
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  VersionApi,
} from '@kubernetes/client-node';

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

export type KubeconfigValidation =
  | { ok: true; contexts: string[]; currentContext: string }
  | { ok: false; code: 'KUBECONFIG_INVALID' | 'UNSUPPORTED_AUTH_PLUGIN'; message: string };

/**
 * Spec §Access modes: exactly one context (or an explicit one); no exec /
 * auth-provider plugins (the binary is not in the pod); no file references
 * (nothing else is mounted); no insecure-skip-tls-verify.
 */
const FILE_REFERENCE_KEY =
  /^\s*(token-file|certificate-authority|client-certificate|client-key)\s*:/m;

export function validateKubeconfigText(text: string, context?: string): KubeconfigValidation {
  // Must run before loadFromString: client-node's findToken() reads
  // user['token-file'] off the filesystem DURING parsing, before any of the
  // checks below run, which would let a pasted kubeconfig exfiltrate any
  // readable pod file (e.g. the ServiceAccount token) as a bearer credential.
  if (FILE_REFERENCE_KEY.test(text)) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message:
        'file references (token-file, certificate-authority, client-certificate, client-key) are not allowed; inline the *-data fields instead',
    };
  }
  const kc = new KubeConfig();
  try {
    kc.loadFromString(text);
  } catch (err) {
    const e = err as { reason?: string; mark?: { line?: number; column?: number } };
    const where =
      e.mark && typeof e.mark.line === 'number'
        ? ` (line ${e.mark.line + 1}${typeof e.mark.column === 'number' ? `, column ${e.mark.column + 1}` : ''})`
        : '';
    const reason = typeof e.reason === 'string' && e.reason ? e.reason : 'not valid YAML';
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: `kubeconfig does not parse: ${reason}${where}`,
    };
  }
  const contexts = kc.getContexts().map((c) => c.name);
  if (context) {
    if (!contexts.includes(context)) {
      return {
        ok: false,
        code: 'KUBECONFIG_INVALID',
        message: `context "${context}" not found (have: ${contexts.join(', ') || 'none'})`,
      };
    }
    kc.setCurrentContext(context);
  } else if (contexts.length !== 1) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message:
        contexts.length === 0
          ? 'kubeconfig has no contexts'
          : `kubeconfig has ${contexts.length} contexts; pass "context" to pick one`,
    };
  } else if (!kc.getCurrentContext()) {
    kc.setCurrentContext(contexts[0]);
  }
  const user = kc.getCurrentUser();
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: 'current context has no cluster.server',
    };
  }
  if (cluster.skipTLSVerify) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: 'insecure-skip-tls-verify is not allowed; supply certificate-authority-data',
    };
  }
  if (cluster.caFile || user?.certFile || user?.keyFile) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message:
        'file references are not allowed; inline certificate-authority-data / client-certificate-data / client-key-data',
    };
  }
  if (user?.exec || user?.authProvider) {
    return {
      ok: false,
      code: 'UNSUPPORTED_AUTH_PLUGIN',
      message:
        'kubeconfig user relies on an exec/auth-provider plugin, which cannot run inside ShipIt; paste a ServiceAccount token instead',
    };
  }
  if (!user || !(user.token || user.certData || user.keyData || user.username)) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: 'kubeconfig user carries no token, client certificate or basic-auth credentials',
    };
  }
  return { ok: true, contexts, currentContext: kc.getCurrentContext() };
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
      kc.loadFromString(creds.kubeconfig);
      kc.setCurrentContext(v.currentContext);
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
