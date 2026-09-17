import { buildCanonicalId, buildScopedCanonicalId, buildLinkingKey } from '@shipit-ai/shared';
import type { WorkloadKind } from '../types.js';

export interface ParsedImage {
  /** Registry host; `docker.io` when the reference has none. */
  registry: string;
  /** Repository path without the registry, e.g. `ship-it-ai-portal/shipit-ai/api-server`. */
  repository: string;
  tag?: string;
  digest?: string;
  /** Last path segment of `repository` — the image-name linking signal. */
  name: string;
}

const DIGEST_RE = /@(sha256:[a-f0-9]{64})$/;

/** Split an OCI image reference into registry / repository / tag / digest. */
export function parseImageRef(ref: string): ParsedImage {
  let rest = ref.trim();
  let digest: string | undefined;
  const d = rest.match(DIGEST_RE);
  if (d) {
    digest = d[1];
    rest = rest.slice(0, -d[0].length);
  }
  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf('/');
  const lastColon = rest.lastIndexOf(':');
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
  }
  const firstSlash = rest.indexOf('/');
  const firstSegment = firstSlash === -1 ? '' : rest.slice(0, firstSlash);
  const looksLikeRegistry =
    firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost';
  let registry = 'docker.io';
  let repository = rest;
  if (looksLikeRegistry) {
    registry = firstSegment;
    repository = rest.slice(firstSlash + 1);
  } else if (firstSlash === -1) {
    repository = `library/${rest}`;
  }
  const name = repository.slice(repository.lastIndexOf('/') + 1);
  return { registry, repository, tag, digest, name };
}

// Strip leading and trailing `-`. The obvious `/^-+|-+$/g` backtracks
// quadratically on a long run of dashes (CodeQL js/polynomial-redos): the
// engine retries `-+$` from every position in the run. Leading dashes are
// anchored so `/^-+/` is linear; trailing dashes are counted with an index
// walk instead of a regex. Same result, no backtracking.
function trimDashes(s: string): string {
  const start = s.replace(/^-+/, '');
  let end = start.length;
  while (end > 0 && start[end - 1] === '-') end--;
  return start.slice(0, end);
}

/** Lower-case, `[a-z0-9._/-]` only — the LogicalService id segment. */
export function normalizeServiceName(raw: string): string {
  return trimDashes(
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, '-'),
  );
}

/** GitHub-team-slug style: lower-case, spaces → `-`, `[a-z0-9._-]` only. */
export function slugify(raw: string): string {
  return trimDashes(
    raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9._-]+/g, '-'),
  );
}

function imageIdentity(image: ParsedImage): string {
  return `${image.registry}/${image.repository}@${image.digest ?? image.tag ?? 'latest'}`;
}

/** Canonical ids. Cluster-scoped where the spec says so; Environment / LogicalService /
 *  BuildArtifact are global so later sources merge by primary key. */
export const ids = {
  cluster: (cluster: string) => buildCanonicalId('Cluster', 'default', cluster),
  namespace: (cluster: string, ns: string) =>
    buildScopedCanonicalId('Namespace', 'default', cluster, ns),
  deployment: (cluster: string, ns: string, kind: WorkloadKind, name: string) =>
    buildScopedCanonicalId('Deployment', 'default', cluster, `${ns}/${kind.toLowerCase()}/${name}`),
  environment: (env: string) => buildCanonicalId('Environment', 'default', env),
  logicalService: (serviceName: string) =>
    buildCanonicalId('LogicalService', 'default', normalizeServiceName(serviceName)),
  buildArtifact: (image: ParsedImage) =>
    buildCanonicalId('BuildArtifact', 'default', imageIdentity(image)),
  repository: (org: string, name: string) =>
    buildScopedCanonicalId('Repository', 'default', org, name),
  team: (org: string, slug: string) => buildScopedCanonicalId('Team', 'default', org, slug),
};

/** Linking keys (`_source_id`). Always `k8s://<cluster>/…` so `parseLinkingKey` accepts them. */
export const keys = {
  cluster: (cluster: string) => buildLinkingKey('kubernetes', cluster),
  namespace: (cluster: string, ns: string) => buildLinkingKey('kubernetes', cluster, ns),
  workload: (cluster: string, ns: string, kind: WorkloadKind, name: string) =>
    buildLinkingKey('kubernetes', cluster, ns, kind.toLowerCase(), name),
  environment: (cluster: string, env: string) =>
    buildLinkingKey('kubernetes', cluster, 'environment', env),
  service: (cluster: string, serviceName: string) =>
    buildLinkingKey('kubernetes', cluster, 'service', normalizeServiceName(serviceName)),
  image: (cluster: string, image: ParsedImage) =>
    buildLinkingKey('kubernetes', cluster, 'image', imageIdentity(image)),
};
