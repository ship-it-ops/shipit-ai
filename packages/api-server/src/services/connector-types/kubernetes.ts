import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  KubernetesConnector,
  WorkloadFetcher,
  buildKubeConfig,
  classifyError,
  defaultClientFactory,
  encodeCursor,
  fetchNamespaces,
  withTimeout,
  type ClientFactory,
  type KubeClients,
  type KubernetesAccessCredentials,
} from '@shipit-ai/connector-kubernetes';
import {
  KUBERNETES_WORKLOAD_KINDS,
  type ConnectorInstanceConfig,
  type KubernetesConnectorConfig,
  type KubernetesWorkloadKind,
} from '@shipit-ai/shared';
import type { BuildContext, BuildResult, ConnectorType, ProbeResult } from './types.js';

const PROBE_TIMEOUT_MS = 30_000;
/**
 * Overall budget. `PROBE_TIMEOUT_MS` is per call and the probe issues several
 * serially, so without this a single request could hold a socket for minutes —
 * and the endpoint allows 30/min.
 */
const PROBE_BUDGET_MS = 60_000;

// Pinned read — basename() over the trusted key dir. The route layer already
// rejected paths outside the dir (isAllowedKeyPath); this keeps the sink safe
// even if a stored config was hand-edited.
function readKeyFile(keyDir: string, configuredPath: string): string {
  return readFileSync(join(keyDir, basename(configuredPath)), 'utf-8');
}

/** Stored `access` block → the `ConnectorConfig.credentials` map the connector parses. */
export function credentialsFromAccess(
  access: KubernetesConnectorConfig['access'],
  keyDir: string,
): Record<string, string> {
  switch (access.mode) {
    case 'in-cluster':
      return { mode: 'in-cluster' };
    case 'kubeconfig':
      return {
        mode: 'kubeconfig',
        kubeconfig: readKeyFile(keyDir, access.kubeconfigPath),
        ...(access.context ? { context: access.context } : {}),
      };
    case 'token':
      return {
        mode: 'token',
        server: access.server,
        token: readKeyFile(keyDir, access.tokenPath).trim(),
        ...(access.caDataPath
          ? {
              caData: Buffer.from(readKeyFile(keyDir, access.caDataPath), 'utf-8').toString(
                'base64',
              ),
            }
          : {}),
      };
  }
}

/** Spec §Repository linking tiers: explicit org, else the sole enabled GitHub connector's org, else null. */
export function resolveGithubOrg(
  cfg: KubernetesConnectorConfig,
  connectors: ConnectorInstanceConfig[],
): string | null {
  if (cfg.mapping.repoLink.githubOrg) return cfg.mapping.repoLink.githubOrg;
  const orgs = new Set<string>();
  for (const c of connectors) if (c.type === 'github' && c.enabled) orgs.add(c.org);
  return orgs.size === 1 ? [...orgs][0] : null;
}

export interface KubernetesProbeBody {
  type: 'kubernetes';
  access:
    | { mode: 'in-cluster' }
    | { mode: 'kubeconfig'; kubeconfig?: string; kubeconfigPath?: string; context?: string }
    | {
        mode: 'token';
        server: string;
        token?: string;
        tokenPath?: string;
        caData?: string;
        caDataPath?: string;
      };
  namespaces?: { include?: string[]; exclude?: string[] };
  kinds?: KubernetesWorkloadKind[];
}

// Inline values win; a *Path falls back to the pinned key-dir read. `caData`
// is PEM text in both cases (the credentials route stores PEM); the connector
// wants base64.
function probeCredentials(
  access: KubernetesProbeBody['access'],
  keyDir: string,
): KubernetesAccessCredentials {
  switch (access.mode) {
    case 'in-cluster':
      return { mode: 'in-cluster' };
    case 'kubeconfig': {
      const text =
        access.kubeconfig ??
        (access.kubeconfigPath ? readKeyFile(keyDir, access.kubeconfigPath) : undefined);
      if (!text) throw new Error('kubeconfig or kubeconfigPath is required for mode kubeconfig');
      return { mode: 'kubeconfig', kubeconfig: text, context: access.context || undefined };
    }
    case 'token': {
      const token =
        access.token ??
        (access.tokenPath ? readKeyFile(keyDir, access.tokenPath).trim() : undefined);
      if (!access.server || !token)
        throw new Error('server and token (or tokenPath) are required for mode token');
      const caPem =
        access.caData ?? (access.caDataPath ? readKeyFile(keyDir, access.caDataPath) : undefined);
      return {
        mode: 'token',
        server: access.server,
        token,
        caData: caPem ? Buffer.from(caPem, 'utf-8').toString('base64') : undefined,
      };
    }
    default:
      // Static: `access.mode` is unvalidated user input and this reaches a 400 body.
      throw new Error('unknown access mode; expected one of in-cluster, kubeconfig, token');
  }
}

async function probeKubernetes(
  body: KubernetesProbeBody,
  ctx: BuildContext,
  clientFactory: ClientFactory,
): Promise<ProbeResult> {
  try {
    return await withTimeout(
      runProbe(body, ctx, clientFactory),
      PROBE_BUDGET_MS,
      'connection probe',
    );
  } catch (err) {
    // withTimeout throws a TIMEOUT KubernetesError; classifyError passes it through
    // so the budget surfaces in the same shape as every other probe failure.
    const e = classifyError(err);
    return { ok: false, code: e.code, message: e.message };
  }
}

async function runProbe(
  body: KubernetesProbeBody,
  ctx: BuildContext,
  clientFactory: ClientFactory,
): Promise<ProbeResult> {
  let creds: KubernetesAccessCredentials;
  try {
    creds = probeCredentials(body.access, ctx.keyDir);
  } catch (err) {
    return { ok: false, code: 'CREDENTIALS_UNREADABLE', message: (err as Error).message };
  }
  let clients: KubeClients;
  let version: string;
  try {
    clients = clientFactory(buildKubeConfig(creds));
    version = (await withTimeout(clients.version.getCode(), PROBE_TIMEOUT_MS, 'GET /version'))
      .gitVersion;
  } catch (err) {
    const e = classifyError(err);
    return { ok: false, code: e.code, message: e.message };
  }
  const include = body.namespaces?.include?.length ? body.namespaces.include : ['*'];
  const exclude = body.namespaces?.exclude ?? ['kube-system', 'kube-public', 'kube-node-lease'];
  let namespaces: string[];
  try {
    namespaces = (
      await fetchNamespaces(clients, { include, exclude }, undefined, PROBE_TIMEOUT_MS)
    ).refs.map((r) => r.name);
  } catch (err) {
    const e = classifyError(err);
    return { ok: false, code: e.code, message: e.message };
  }
  const kinds = body.kinds?.length ? body.kinds : [...KUBERNETES_WORKLOAD_KINDS];
  const kindStatus: Record<string, 'ok' | 'forbidden' | 'error' | 'skipped'> = {};
  const target = namespaces[0];
  if (!target) {
    for (const kind of kinds) kindStatus[kind] = 'skipped';
    return { ok: true, cluster: { version }, namespaces, kinds: kindStatus };
  }
  // ONE fetcher for every kind: it lists the target namespace's pods and
  // ReplicaSets once and reuses them, where a fetcher per kind paged all of
  // them again for each of the four kinds. The explicit cursor addresses
  // exactly one (namespace, kind) page, so per-kind attribution is unchanged.
  const fetcher = new WorkloadFetcher(
    clients,
    [{ name: target, labels: {}, annotations: {} }],
    kinds,
    PROBE_TIMEOUT_MS,
  );
  for (const [index, kind] of kinds.entries()) {
    const warningsBefore = fetcher.warnings.length;
    try {
      await fetcher.fetch(encodeCursor(0, index));
      kindStatus[kind] = fetcher.warnings.length > warningsBefore ? 'forbidden' : 'ok';
    } catch {
      kindStatus[kind] = 'error';
    }
  }
  return { ok: true, cluster: { version }, namespaces, kinds: kindStatus };
}

export function makeKubernetesConnectorType(
  clientFactory: ClientFactory = defaultClientFactory,
): ConnectorType<KubernetesConnectorConfig> {
  return {
    type: 'kubernetes',
    // Every run is a full list, so every successful poll drives the absence sweep.
    pollMode: 'full',
    // A full list is exhaustive for everything this type writes.
    sweepsAbsent: true,

    async build(cfg, ctx): Promise<BuildResult> {
      let credentials: Record<string, string>;
      try {
        credentials = credentialsFromAccess(cfg.access, ctx.keyDir);
      } catch (err) {
        return {
          ok: false,
          code: 'CREDENTIALS_UNREADABLE',
          message: `Cannot read Kubernetes credentials for ${cfg.id} (${cfg.access.mode}): ${(err as Error).message}`,
        };
      }
      const githubOrg = resolveGithubOrg(cfg, ctx.listConnectors());
      let knownRepositories: string[] = [];
      let knownTeams: string[] = [];
      if (githubOrg) {
        // Lookups are best-effort: without them the name tiers simply do not match.
        try {
          [knownRepositories, knownTeams] = await Promise.all([
            ctx.lookupRepositoryNames?.(githubOrg) ?? Promise.resolve([]),
            ctx.lookupTeamSlugs?.(githubOrg) ?? Promise.resolve([]),
          ]);
        } catch (err) {
          (ctx.logger ?? console).warn(
            `kubernetes connector ${cfg.id}: graph lookups failed, name-match tiers disabled this run`,
            { err: (err as Error).message },
          );
          knownRepositories = [];
          knownTeams = [];
        }
      }
      return {
        ok: true,
        connector: new KubernetesConnector(clientFactory),
        sdkConfig: {
          id: cfg.id,
          type: 'kubernetes',
          credentials,
          scope: {
            cluster: cfg.cluster.name,
            namespaces: cfg.scope.namespaces,
            kinds: cfg.scope.kinds,
            mapping: cfg.mapping,
            githubOrg,
            knownRepositories,
            knownTeams,
          },
        },
      };
    },

    probe(body, ctx) {
      return probeKubernetes(body as KubernetesProbeBody, ctx, clientFactory);
    },
  };
}

export const kubernetesConnectorType = makeKubernetesConnectorType();
