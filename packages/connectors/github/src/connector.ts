import { Octokit } from '@octokit/rest';
import type { CanonicalEntity } from '@shipit-ai/shared';
import type {
  ShipItConnector,
  ConnectorConfig,
  ConnectorManifest,
  AuthResult,
  DiscoveryResult,
  FetchResult,
  SyncResult,
  WebhookEvent,
} from '@shipit-ai/connector-sdk';
import { authenticateGitHubApp, authenticatePAT } from './auth.js';
import { fetchRepositories } from './fetchers/repositories.js';
import type { GitHubRepo } from './fetchers/repositories.js';
import { fetchTeams } from './fetchers/teams.js';
import type { GitHubTeam } from './fetchers/teams.js';
import { fetchWorkflows } from './fetchers/workflows.js';
import type { GitHubWorkflow } from './fetchers/workflows.js';
import { fetchCodeowners } from './fetchers/codeowners.js';
import type { CodeownersEntry } from './fetchers/codeowners.js';
import { normalizeRepository } from './normalizers/repository.js';
import { normalizeTeam } from './normalizers/team.js';
import { normalizePipeline } from './normalizers/pipeline.js';
import { normalizeCodeowner } from './normalizers/codeowner.js';

export class GitHubConnector implements ShipItConnector {
  readonly manifest: ConnectorManifest = {
    name: 'github',
    version: '1.0.0',
    schema_version: '1.0',
    min_sdk_version: '0.1.0',
    supported_entity_types: ['Repository', 'Team', 'Person', 'Pipeline'],
  };

  private octokit: Octokit | null = null;
  private org = '';
  private repoNames: string[] = [];

  async authenticate(config: ConnectorConfig): Promise<AuthResult> {
    this.org = config.scope['org'] as string;

    if (config.credentials['appId'] && config.credentials['privateKey']) {
      const result = await authenticateGitHubApp({
        appId: config.credentials['appId'],
        privateKey: config.credentials['privateKey'],
        installationId: config.credentials['installationId'],
      });
      this.octokit = result.octokit;
      return result.auth;
    }

    if (config.credentials['token']) {
      const result = await authenticatePAT({
        token: config.credentials['token'],
      });
      this.octokit = result.octokit;
      return result.auth;
    }

    return { success: false, error: 'No valid credentials provided' };
  }

  async discover(): Promise<DiscoveryResult> {
    return {
      entity_types: ['Repository', 'Team', 'Pipeline', 'Codeowners'],
      total_entities: {},
    };
  }

  async fetch(entityType: string, cursor?: string): Promise<FetchResult> {
    if (!this.octokit) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    switch (entityType) {
      case 'Repository': {
        const result = await fetchRepositories(this.octokit, this.org, cursor);
        // Cache repo names for workflow/codeowner fetching
        if (!cursor) this.repoNames = [];
        for (const entity of result.entities as GitHubRepo[]) {
          this.repoNames.push(entity.name);
        }
        return result;
      }
      case 'Team':
        return fetchTeams(this.octokit, this.org, cursor);
      case 'Pipeline':
        return fetchWorkflows(this.octokit, this.org, this.repoNames, cursor);
      case 'Codeowners':
        return fetchCodeowners(this.octokit, this.org, this.repoNames, cursor);
      default:
        return { entities: [], has_more: false };
    }
  }

  normalize(raw: unknown[]): CanonicalEntity {
    const allNodes: CanonicalEntity['nodes'] = [];
    const allEdges: CanonicalEntity['edges'] = [];

    for (const entity of raw) {
      const record = entity as Record<string, unknown>;

      if ('full_name' in record && 'default_branch' in record) {
        // Repository
        const result = normalizeRepository(record as unknown as GitHubRepo, this.org);
        allNodes.push(...result.nodes);
        allEdges.push(...result.edges);
      } else if ('slug' in record && 'members' in record) {
        // Team
        const result = normalizeTeam(record as unknown as GitHubTeam, this.org);
        allNodes.push(...result.nodes);
        allEdges.push(...result.edges);
      } else if ('path' in record && 'repo_name' in record && 'state' in record) {
        // Workflow/Pipeline
        const result = normalizePipeline(record as unknown as GitHubWorkflow, this.org);
        allNodes.push(...result.nodes);
        allEdges.push(...result.edges);
      } else if ('pattern' in record && 'owners' in record) {
        // Codeowners entry
        const result = normalizeCodeowner(record as unknown as CodeownersEntry, this.org);
        allEdges.push(...result.edges);
      }
    }

    return { nodes: allNodes, edges: allEdges };
  }

  async sync(mode: 'full' | 'incremental'): Promise<SyncResult> {
    const startTime = Date.now();
    let entitiesSynced = 0;
    const errors: string[] = [];

    try {
      const discovery = await this.discover();

      for (const entityType of discovery.entity_types) {
        let cursor: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const result = await this.fetch(entityType, cursor);
          entitiesSynced += result.entities.length;
          cursor = result.cursor;
          hasMore = result.has_more;
        }
      }

      return {
        status: errors.length > 0 ? 'partial' : 'success',
        entities_synced: entitiesSynced,
        errors,
        duration_ms: Date.now() - startTime,
      };
    } catch (err) {
      return {
        status: 'failed',
        entities_synced: entitiesSynced,
        errors: [err instanceof Error ? err.message : String(err)],
        duration_ms: Date.now() - startTime,
      };
    }
  }

  async handleWebhook(event: WebhookEvent): Promise<void> {
    // Webhook handling to be implemented in future iterations
    // Will handle push, pull_request, workflow_run events
    void event;
  }
}
