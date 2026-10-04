// Drives a KnowledgeConnector the way ConnectorHarness drives a ShipItConnector,
// with two differences the knowledge layer needs: a per-batch checkpoint the
// sink commits with the batch (so an interrupted backfill resumes), and a time
// budget (so one container's backfill cannot hold a job for hours).
import type { ConnectorConfig } from '../interface.js';
import type {
  KnowledgeConnector,
  KnowledgeRunMode,
  KnowledgeRunResult,
  KnowledgeSink,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from './types.js';

export interface KnowledgeHarnessOptions {
  /** Backfill horizon in days; 0 means everything. */
  historyDays: number;
  /** Window for the connector's own reconcile hook. Default 14. */
  rescanDays?: number;
  /** Wall-clock budget for one run. The run yields between batches once it is spent. */
  budgetMs: number;
  /** Test seam. */
  now?: () => number;
  log?: (line: string) => void;
}

const PRINCIPAL_BATCH = 500;

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number };
  return e.status ?? e.statusCode;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type RecordError = (scope: string, err: unknown) => void;

export class KnowledgeHarness {
  private readonly now: () => number;

  constructor(
    private readonly connector: KnowledgeConnector,
    private readonly sink: KnowledgeSink,
    private readonly config: ConnectorConfig,
    private readonly options: KnowledgeHarnessOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async run(mode: KnowledgeRunMode): Promise<KnowledgeRunResult> {
    const startedAt = this.now();
    const deadline = startedAt + this.options.budgetMs;
    const result: KnowledgeRunResult = {
      status: 'success',
      documentsSynced: 0,
      documentsDeleted: 0,
      containersProcessed: 0,
      errors: [],
      authFailed: false,
      budgetExhausted: false,
      durationMs: 0,
    };
    const finish = (): KnowledgeRunResult => {
      result.durationMs = Math.max(0, this.now() - startedAt);
      if (result.errors.length === 0) result.status = 'success';
      else result.status = result.containersProcessed > 0 ? 'partial' : 'failed';
      return result;
    };
    const budgetLeft = (): boolean => {
      if (this.now() < deadline) return true;
      result.budgetExhausted = true;
      return false;
    };
    const recordError: RecordError = (scope, err) => {
      result.errors.push(`${scope}: ${messageOf(err)}`);
      const status = statusOf(err);
      if (status === 401 || status === 403) result.authFailed = true;
    };

    let auth;
    try {
      auth = await this.connector.authenticate(this.config);
    } catch (err) {
      recordError('authenticate', err);
      result.authFailed = true;
      return finish();
    }
    if (!auth.success) {
      result.errors.push(auth.error ?? 'Authentication failed');
      result.authFailed = true;
      return finish();
    }

    if (mode === 'reconcile') {
      await this.refreshContainers(recordError);
      await this.refreshPrincipals(recordError);
    }

    const containers = await this.sink.selectedContainers();
    for (const container of containers) {
      if (!budgetLeft()) break;
      const scope = `container ${container.name} (${container.externalId})`;
      try {
        if (mode === 'poll') {
          await this.pollContainer(container, result, budgetLeft);
        } else {
          await this.reconcileContainer(container, result, budgetLeft);
        }
        result.containersProcessed += 1;
      } catch (err) {
        recordError(scope, err);
      }
    }
    return finish();
  }

  private async pollContainer(
    container: SelectedContainer,
    result: KnowledgeRunResult,
    budgetLeft: () => boolean,
  ): Promise<void> {
    const batches = this.connector.fetchChanges(container, container.checkpoint, {
      historyDays: this.options.historyDays,
    });
    for await (const batch of batches) {
      const stored = await this.sink.storeBatch(container, batch);
      result.documentsSynced += stored.changed;
      result.documentsDeleted += stored.deleted;
      container.checkpoint = batch.checkpoint;
      // `break` runs the generator's return(): the connector stops fetching.
      if (!budgetLeft()) break;
    }
  }

  private async reconcileContainer(
    container: SelectedContainer,
    result: KnowledgeRunResult,
    budgetLeft: () => boolean,
  ): Promise<void> {
    if (this.connector.reconcile) {
      const batches = this.connector.reconcile(container, {
        days: this.options.rescanDays ?? 14,
      });
      for await (const batch of batches) {
        const stored = await this.sink.storeBatch(container, batch);
        result.documentsSynced += stored.changed;
        result.documentsDeleted += stored.deleted;
        if (!budgetLeft()) return;
      }
    }
    // Collect the WHOLE listing before pruning: a listing that throws halfway
    // must never delete anything (spec §Error handling).
    const presentIds: string[] = [];
    for await (const page of this.connector.listDocumentIds(container)) {
      presentIds.push(...page);
    }
    result.documentsDeleted += await this.sink.pruneMissing(container, presentIds);
  }

  private async refreshContainers(recordError: RecordError): Promise<void> {
    const all: SourceContainer[] = [];
    try {
      for await (const c of this.connector.listContainers()) all.push(c);
    } catch (err) {
      recordError('listContainers', err);
      return; // an incomplete list must not mark anything gone
    }
    await this.sink.upsertContainers(all);
  }

  private async refreshPrincipals(recordError: RecordError): Promise<void> {
    let page: SourcePrincipal[] = [];
    try {
      for await (const p of this.connector.listPrincipals()) {
        page.push(p);
        if (page.length >= PRINCIPAL_BATCH) {
          await this.sink.upsertPrincipals(page);
          page = [];
        }
      }
      if (page.length > 0) await this.sink.upsertPrincipals(page);
    } catch (err) {
      recordError('listPrincipals', err);
    }
  }
}
