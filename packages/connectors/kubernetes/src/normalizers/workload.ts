import type { V1CronJob, V1DaemonSet, V1Deployment, V1StatefulSet } from '@kubernetes/client-node';
import type { CanonicalEdge, CanonicalNode, KubernetesMappingConfig } from '@shipit-ai/shared';
import type { NormalizeOutput, NormalizerContext, RawWorkload } from '../types.js';
import { compact, LOGICAL_SERVICE_CLAIM_CONFIDENCE, makeEdge, makeNode } from './claims.js';
import { deriveEnvironment, environmentType } from './environment.js';
import { ids, keys, parseImageRef, type ParsedImage } from './identity.js';
import { resolveRepositoryLink, resolveTeamLink } from './linking.js';

interface WorkloadShape {
  containers: Array<{ name: string; image: string }>;
  replicas?: number;
  readyReplicas?: number;
  status: 'Available' | 'Progressing' | 'Degraded' | 'Suspended' | 'Unknown';
}

function containersOf(
  spec: { containers?: Array<{ name: string; image?: string }> } | undefined,
): Array<{ name: string; image: string }> {
  return (spec?.containers ?? [])
    .filter(
      (c): c is { name: string; image: string } =>
        typeof c.image === 'string' && c.image.length > 0,
    )
    .map((c) => ({ name: c.name, image: c.image }));
}

function replicaStatus(desired: number, ready: number): WorkloadShape['status'] {
  if (desired === 0) return 'Unknown';
  if (ready >= desired) return 'Available';
  if (ready > 0) return 'Progressing';
  return 'Degraded';
}

/** Per-kind extraction of containers, replica counts and a normalized status. */
export function workloadShape(raw: RawWorkload): WorkloadShape {
  switch (raw.kind) {
    case 'Deployment': {
      const o = raw.object as V1Deployment;
      const conditions = o.status?.conditions ?? [];
      const available = conditions.find((c) => c.type === 'Available');
      const progressing = conditions.find((c) => c.type === 'Progressing');
      const status: WorkloadShape['status'] =
        available?.status === 'True'
          ? 'Available'
          : progressing?.status === 'True'
            ? 'Progressing'
            : available?.status === 'False'
              ? 'Degraded'
              : 'Unknown';
      return {
        containers: containersOf(o.spec?.template?.spec),
        replicas: o.spec?.replicas ?? 1,
        readyReplicas: o.status?.readyReplicas ?? 0,
        status,
      };
    }
    case 'StatefulSet': {
      const o = raw.object as V1StatefulSet;
      const replicas = o.spec?.replicas ?? 1;
      const ready = o.status?.readyReplicas ?? 0;
      return {
        containers: containersOf(o.spec?.template?.spec),
        replicas,
        readyReplicas: ready,
        status: replicaStatus(replicas, ready),
      };
    }
    case 'DaemonSet': {
      const o = raw.object as V1DaemonSet;
      const desired = o.status?.desiredNumberScheduled ?? 0;
      const ready = o.status?.numberReady ?? 0;
      return {
        containers: containersOf(o.spec?.template?.spec),
        replicas: desired,
        readyReplicas: ready,
        status: replicaStatus(desired, ready),
      };
    }
    case 'CronJob': {
      const o = raw.object as V1CronJob;
      return {
        containers: containersOf(o.spec?.jobTemplate?.spec?.template?.spec),
        status: o.spec?.suspend ? 'Suspended' : 'Available',
      };
    }
  }
}

/** Spec §Service identity: first present of part-of / name / workload name, optionally + component. */
export function deriveServiceName(
  workloadName: string,
  labels: Record<string, string>,
  mapping: KubernetesMappingConfig['service'],
): string {
  let base: string | undefined;
  for (const source of mapping.nameFrom) {
    const candidate =
      source === 'part-of'
        ? labels['app.kubernetes.io/part-of']
        : source === 'name'
          ? labels['app.kubernetes.io/name']
          : workloadName;
    if (candidate && candidate.trim()) {
      base = candidate.trim();
      break;
    }
  }
  base ??= workloadName;
  const component = labels['app.kubernetes.io/component'];
  return mapping.includeComponent && component ? `${base}/${component}` : base;
}

function selectedLabels(
  labels: Record<string, string>,
  mapping: KubernetesMappingConfig,
): string[] {
  const keep = new Set([mapping.environment.label, 'env', mapping.ownership.teamLabel]);
  return Object.entries(labels)
    .filter(([k]) => k.startsWith('app.kubernetes.io/') || keep.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .sort();
}

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) return value;
  return undefined;
}

export function normalizeWorkload(raw: RawWorkload, ctx: NormalizerContext): NormalizeOutput {
  const warnings: string[] = [];
  const meta = raw.object.metadata ?? {};
  const name = meta.name;
  if (!name)
    return { nodes: [], edges: [], warnings: [`${raw.kind} without metadata.name skipped`] };
  const ns = raw.namespace.name;
  const labels = meta.labels ?? {};
  const annotations = meta.annotations ?? {};
  const shape = workloadShape(raw);

  const images: Array<{ container: string; ref: string; image: ParsedImage }> =
    shape.containers.map((c) => ({
      container: c.name,
      ref: c.image,
      image: parseImageRef(c.image),
    }));
  for (const i of images) {
    const digest = raw.pods.imageDigests[i.container];
    if (digest) i.image.digest = digest;
  }

  const env = deriveEnvironment({
    workloadLabels: labels,
    namespaceLabels: raw.namespace.labels,
    namespaceName: ns,
    mapping: ctx.mapping.environment,
  });

  const deploymentId = ids.deployment(ctx.cluster, ns, raw.kind, name);
  const sourceId = keys.workload(ctx.cluster, ns, raw.kind, name);
  const properties = compact({
    name,
    namespace: ns,
    cluster: ctx.cluster,
    kind: raw.kind,
    environment: env?.environment,
    image: images[0]?.ref,
    images: images.map((i) => i.ref),
    replicas: shape.replicas,
    ready_replicas: shape.readyReplicas,
    status: shape.status,
    created_at: toIso(meta.creationTimestamp),
    restarts: raw.pods.restarts,
    labels: selectedLabels(labels, ctx.mapping),
  });

  const nodes: CanonicalNode[] = [makeNode(deploymentId, 'Deployment', properties, sourceId, ctx)];
  const edges: CanonicalEdge[] = [
    makeEdge('RUNS_IN', deploymentId, ids.namespace(ctx.cluster, ns), 1.0, ctx.now),
  ];

  if (env) {
    const envId = ids.environment(env.environment);
    const envProps = compact({ name: env.environment, type: environmentType(env.environment) });
    nodes.push(
      makeNode(envId, 'Environment', envProps, keys.environment(ctx.cluster, env.environment), ctx),
    );
    edges.push(
      makeEdge('RUNS_IN_ENV', deploymentId, envId, env.confidence, ctx.now, {
        derived_from: env.derivedFrom,
      }),
    );
  }

  const repo = resolveRepositoryLink({
    annotations,
    namespaceAnnotations: raw.namespace.annotations,
    labels,
    images: images.map((i) => i.image),
    mapping: ctx.mapping.repoLink,
    knownRepositories: ctx.knownRepositories,
    githubOrg: ctx.githubOrg,
  });
  warnings.push(...repo.warnings);
  const repoId = repo.link ? ids.repository(repo.link.org, repo.link.repo) : null;

  const seenArtifacts = new Set<string>();
  for (const i of images) {
    const artifactId = ids.buildArtifact(i.image);
    if (!seenArtifacts.has(artifactId)) {
      seenArtifacts.add(artifactId);
      const artifactProps = compact({
        name: i.image.repository,
        image_tag: i.image.tag,
        sha: i.image.digest,
        registry: i.image.registry,
      });
      nodes.push(
        makeNode(artifactId, 'BuildArtifact', artifactProps, keys.image(ctx.cluster, i.image), ctx),
      );
      if (repoId && repo.link) {
        edges.push(
          makeEdge('BUILT_FROM', artifactId, repoId, repo.link.confidence, ctx.now, {
            link_method: repo.link.linkMethod,
          }),
        );
      }
    }
    edges.push(
      makeEdge('RUNS_IMAGE', deploymentId, artifactId, 1.0, ctx.now, { container: i.container }),
    );
  }

  const serviceName = deriveServiceName(name, labels, ctx.mapping.service);
  const serviceId = ids.logicalService(serviceName);
  const serviceProps = { name: serviceName };
  nodes.push(
    makeNode(
      serviceId,
      'LogicalService',
      serviceProps,
      keys.service(ctx.cluster, serviceName),
      ctx,
      LOGICAL_SERVICE_CLAIM_CONFIDENCE,
    ),
  );
  edges.push(makeEdge('DEPLOYED_AS', serviceId, deploymentId, 1.0, ctx.now));
  if (repoId && repo.link) {
    edges.push(
      makeEdge('IMPLEMENTED_BY', serviceId, repoId, repo.link.confidence, ctx.now, {
        link_method: repo.link.linkMethod,
      }),
    );
  }

  const team = resolveTeamLink({
    labels,
    namespaceLabels: raw.namespace.labels,
    teamLabel: ctx.mapping.ownership.teamLabel,
    knownTeams: ctx.knownTeams,
    githubOrg: ctx.githubOrg,
  });
  warnings.push(...team.warnings);
  if (team.link) {
    edges.push(
      makeEdge(
        'OWNS',
        ids.team(team.link.org, team.link.slug),
        serviceId,
        team.link.confidence,
        ctx.now,
        { derived_from: team.link.derivedFrom },
      ),
    );
  }

  return { nodes, edges, warnings };
}
