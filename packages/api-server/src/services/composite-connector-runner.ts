// The registry knows one ConnectorRunner. This one fans each call out to the
// graph scheduler (SyncScheduler) and the knowledge scheduler, so a connector
// with both facets (GitHub) is scheduled twice and a knowledge-only connector
// (Slack) still answers start/stop/trigger/status through the same contract.
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import type { ConnectorRunner, SyncRuntimeStatus } from './connector-registry.js';
import type { KnowledgeSyncScheduler } from './knowledge-sync-scheduler.js';

export interface CompositeConnectorRunnerOptions {
  graph: ConnectorRunner | null;
  knowledge: Pick<
    KnowledgeSyncScheduler,
    'handles' | 'start' | 'stop' | 'trigger' | 'getStatus'
  > | null;
  hasGraphFacet: (cfg: ConnectorInstanceConfig) => boolean;
}

export class CompositeConnectorRunner implements ConnectorRunner {
  // Which connectors are knowledge-only, so getStatus(id) can route without a config.
  private readonly knowledgeOnly = new Set<string>();

  constructor(private readonly opts: CompositeConnectorRunnerOptions) {}

  /** Record the facet split for a connector; start() does this, tests call it directly. */
  remember(cfg: ConnectorInstanceConfig): void {
    if (this.opts.hasGraphFacet(cfg)) this.knowledgeOnly.delete(cfg.id);
    else this.knowledgeOnly.add(cfg.id);
  }

  async start(cfg: ConnectorInstanceConfig): Promise<void> {
    this.remember(cfg);
    if (this.opts.graph && this.opts.hasGraphFacet(cfg)) await this.opts.graph.start(cfg);
    if (this.opts.knowledge?.handles(cfg)) await this.opts.knowledge.start(cfg);
  }

  async stop(connectorId: string): Promise<void> {
    await this.opts.graph?.stop(connectorId);
    await this.opts.knowledge?.stop(connectorId);
    this.knowledgeOnly.delete(connectorId);
  }

  async triggerSync(
    cfg: ConnectorInstanceConfig,
    mode: 'full' | 'incremental',
  ): Promise<SyncRuntimeStatus> {
    this.remember(cfg);
    if (this.opts.hasGraphFacet(cfg)) {
      return this.opts.graph ? this.opts.graph.triggerSync(cfg, mode) : idle(cfg.id);
    }
    if (this.opts.knowledge?.handles(cfg)) {
      // "full" for a knowledge connector is the reconcile pass; "incremental" a poll.
      return this.opts.knowledge.trigger(cfg, mode === 'full' ? 'reconcile' : 'poll');
    }
    return idle(cfg.id);
  }

  getStatus(connectorId: string): SyncRuntimeStatus {
    if (this.knowledgeOnly.has(connectorId)) {
      return this.opts.knowledge?.getStatus(connectorId) ?? idle(connectorId);
    }
    return this.opts.graph?.getStatus(connectorId) ?? idle(connectorId);
  }
}

function idle(connectorId: string): SyncRuntimeStatus {
  return { connectorId, state: 'idle', startedAt: new Date().toISOString() };
}
