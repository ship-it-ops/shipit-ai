import type { CanonicalNode, CanonicalEdge, PropertyClaim } from '@shipit-ai/shared';
import {
  buildScopedCanonicalId,
  buildLinkingKey,
  deriveTimeVersion,
  deriveContentVersion,
} from '@shipit-ai/shared';
import type { GitHubWorkflow } from '../fetchers/workflows.js';

function makeClaim(key: string, value: unknown, sourceId: string): PropertyClaim {
  return {
    property_key: key,
    value,
    source: 'github',
    source_id: sourceId,
    ingested_at: new Date().toISOString(),
    confidence: 0.9,
    evidence: null,
  };
}

export function normalizePipeline(
  workflow: GitHubWorkflow,
  org: string,
): { nodes: CanonicalNode[]; edges: CanonicalEdge[] } {
  const now = new Date().toISOString();
  const pipelineName = `${workflow.repo_name}-${workflow.name}`.toLowerCase().replace(/\s+/g, '-');
  const sourceId = buildLinkingKey(
    'github',
    org,
    workflow.repo_name,
    'workflow',
    String(workflow.id),
  );

  const lastRun = workflow.recent_runs[0] ?? null;

  const properties = {
    name: workflow.name,
    path: workflow.path,
    state: workflow.state,
    url: workflow.html_url,
    repo_name: workflow.repo_name,
    last_run_status: lastRun?.status ?? null,
    last_run_conclusion: lastRun?.conclusion ?? null,
    last_run_at: lastRun?.created_at ?? null,
  };

  // Freshness/ordering token: latest run's created_at (advances on each run — the
  // `workflow_run` webhook signal), falling back to the workflow definition's
  // updated_at, then to a stable content hash when neither timestamp is present.
  const eventVersion =
    deriveTimeVersion(lastRun?.created_at ?? null, workflow.updated_at) ??
    deriveContentVersion(properties);

  const node: CanonicalNode = {
    id: buildScopedCanonicalId('Pipeline', 'default', org, pipelineName),
    label: 'Pipeline',
    properties,
    _claims: [
      makeClaim('name', workflow.name, sourceId),
      makeClaim('path', workflow.path, sourceId),
      makeClaim('state', workflow.state, sourceId),
      makeClaim('url', workflow.html_url, sourceId),
    ],
    _source_system: 'github',
    _source_org: `github/${org}`,
    _source_id: sourceId,
    _last_synced: now,
    _event_version: eventVersion,
  };

  const repoId = buildScopedCanonicalId('Repository', 'default', org, workflow.repo_name);

  const edge: CanonicalEdge = {
    type: 'BUILT_BY',
    from: repoId,
    to: node.id,
    _source: 'github',
    _confidence: 0.9,
    _ingested_at: now,
  };

  return { nodes: [node], edges: [edge] };
}
