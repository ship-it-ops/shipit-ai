// Drives a KnowledgeConnector the way ConnectorHarness drives a ShipItConnector,
// with two differences the knowledge layer needs: a per-batch checkpoint the
// sink commits with the batch (so an interrupted backfill resumes), and a time
// budget (so one container's backfill cannot hold a job for hours).
import type { ConnectorConfig } from '../interface.js';
import { isContainerChanged, isRunCutShort } from './errors.js';
import type {
  KnowledgeConnector,
  KnowledgeRunMode,
  KnowledgeRunResult,
  KnowledgeSink,
  RunLimits,
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
  /** Aborted at shutdown: the run stops between batches and the connector gets the signal. */
  signal?: AbortSignal;
  /** Test seam. */
  now?: () => number;
  log?: (line: string) => void;
}

const PRINCIPAL_BATCH = 500;

function statusOf(err: unknown): number | undefined {
  // A connector can throw anything, including null.
  const e = (err ?? {}) as { status?: number; statusCode?: number };
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
      notes: [],
      durationMs: 0,
    };
    const limits: RunLimits = { signal: this.options.signal, deadline };
    const finish = (): KnowledgeRunResult => {
      result.durationMs = Math.max(0, this.now() - startedAt);
      if (result.errors.length === 0) result.status = 'success';
      else result.status = result.containersProcessed > 0 ? 'partial' : 'failed';
      return result;
    };
    const budgetLeft = (): boolean => {
      if (!this.options.signal?.aborted && this.now() < deadline) return true;
      result.budgetExhausted = true;
      return false;
    };
    const recordError: RecordError = (scope, err) => {
      result.errors.push(`${scope}: ${messageOf(err)}`);
      const status = statusOf(err);
      if (status === 401 || status === 403) result.authFailed = true;
    };

    // Shutdown had begun before this run got its turn: nothing to do.
    if (!budgetLeft()) return finish();

    let auth;
    try {
      auth = await this.connector.authenticate(this.config);
    } catch (err) {
      // Shutdown interrupted the call: the run was cut short, it did not fail.
      if (this.options.signal?.aborted) {
        result.budgetExhausted = true;
        return finish();
      }
      recordError('authenticate', err);
      result.authFailed = true;
      return finish();
    }
    if (!auth.success) {
      result.errors.push(auth.error ?? 'Authentication failed');
      result.authFailed = true;
      return finish();
    }

    // Two ways a call can end the run without being a failure. The shutdown
    // signal interrupted it (an aborted request throws): the run ends the way
    // an abort between batches does. Or the source asked for a wait that does
    // not fit this run (a rate limit): it ends there, with the connector's note.
    const cutShort = (err: unknown): boolean => {
      if (this.options.signal?.aborted) {
        result.budgetExhausted = true;
        return true;
      }
      if (!isRunCutShort(err)) return false;
      this.addNotes(result, [err.note]);
      result.budgetExhausted = true;
      return true;
    };

    if (mode === 'reconcile' && (await this.refreshContainers(recordError, cutShort, limits))) {
      return finish();
    }

    let containers: SelectedContainer[];
    try {
      containers = await this.sink.selectedContainers(mode);
    } catch (err) {
      recordError('selectedContainers', err);
      return finish();
    }
    // People are listed only for a connector that has something selected: the
    // store holds names, emails and logins no longer than something uses them.
    if (
      mode === 'reconcile' &&
      containers.length > 0 &&
      (await this.refreshPrincipals(recordError, cutShort, limits))
    ) {
      return finish();
    }
    for (const [index, container] of containers.entries()) {
      if (!budgetLeft()) break;
      const scope = `container ${container.name} (${container.externalId})`;
      try {
        const finished =
          mode === 'poll'
            ? await this.pollContainer(container, result, budgetLeft, limits)
            : await this.reconcileContainer(container, result, budgetLeft, limits);
        if (finished) {
          // Stamped even when nothing changed, so the order of the next run of
          // this mode starts with whoever has waited longest.
          await this.sink.markVisited(container, mode);
          result.containersProcessed += 1;
        } else if (mode === 'reconcile' && index === 0 && !this.options.signal?.aborted) {
          // It had the run to itself and still did not finish, and a reconcile
          // starts over every time. Left unstamped it would sort first every
          // night and no other container of this connector would be checked.
          // (A poll resumes from its checkpoint, so it does finish in the end.)
          await this.sink.markVisited(container, mode);
          this.addNotes(result, [
            `${container.name}: the nightly check did not finish within one run, so deletions there are not being detected`,
          ]);
        }
      } catch (err) {
        if (cutShort(err)) break;
        // The sink refused the batch because the container was deselected, or
        // purged and selected again, since this run read it. Not a failure of
        // the source: leave it for the next run, which reads it afresh.
        if (isContainerChanged(err)) {
          this.addNotes(result, [
            `${container.name}: changed during the run (deselected or reset); skipped`,
          ]);
          continue;
        }
        recordError(scope, err);
      }
    }
    return finish();
  }

  private addNotes(result: KnowledgeRunResult, notes: string[] | undefined): void {
    for (const note of notes ?? []) {
      if (!result.notes.includes(note)) result.notes.push(note);
    }
  }

  /** Returns false when the budget ended the container early. */
  private async pollContainer(
    container: SelectedContainer,
    result: KnowledgeRunResult,
    budgetLeft: () => boolean,
    limits: RunLimits,
  ): Promise<boolean> {
    const batches = this.connector.fetchChanges(container, container.checkpoint, {
      historyDays: this.options.historyDays,
      ...limits,
    });
    const iterator = batches[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done) return true;
      const batch = next.value;
      const stored = await this.sink.storeBatch(container, batch);
      result.documentsSynced += stored.changed;
      result.documentsDeleted += stored.deleted;
      this.addNotes(result, batch.notes);
      if (batch.checkpoint !== null) container.checkpoint = batch.checkpoint;
      if (!budgetLeft()) {
        // return() tells the connector to stop fetching.
        await iterator.return?.();
        return false;
      }
    }
  }

  /** Returns false when the budget ended the container before its prune. */
  private async reconcileContainer(
    container: SelectedContainer,
    result: KnowledgeRunResult,
    budgetLeft: () => boolean,
    limits: RunLimits,
  ): Promise<boolean> {
    if (this.connector.reconcile) {
      const batches = this.connector.reconcile(container, {
        days: this.options.rescanDays ?? 14,
        ...limits,
      });
      for await (const batch of batches) {
        // A rescan must never move the poll cursor.
        const stored = await this.sink.storeBatch(container, { ...batch, checkpoint: null });
        result.documentsSynced += stored.changed;
        result.documentsDeleted += stored.deleted;
        this.addNotes(result, batch.notes);
        if (!budgetLeft()) return false;
      }
    }
    // A connector whose listing covers no kind has nothing to prune by.
    const kinds = this.connector.prunableKinds;
    if (kinds && kinds.length === 0) return true;
    // Collect the WHOLE listing before pruning: a listing that throws halfway,
    // or that the budget cuts short, must never delete anything (spec §Error
    // handling). Documents stored after the listing started were invisible to
    // it and are spared.
    const listedAt = new Date(this.now()).toISOString();
    const presentIds: string[] = [];
    for await (const page of this.connector.listDocumentIds(container, limits)) {
      presentIds.push(...page);
      if (!budgetLeft()) return false;
    }
    result.documentsDeleted += await this.sink.pruneMissing(container, presentIds, {
      listedAt,
      ...(kinds ? { kinds } : {}),
    });
    return true;
  }

  /** Returns true when the run was cut short and must end. */
  private async refreshContainers(
    recordError: RecordError,
    cutShort: (err: unknown) => boolean,
    limits: RunLimits,
  ): Promise<boolean> {
    const all: SourceContainer[] = [];
    try {
      for await (const c of this.connector.listContainers(limits)) all.push(c);
    } catch (err) {
      // Either way an incomplete list must not mark anything gone.
      if (cutShort(err)) return true;
      recordError('listContainers', err);
      return false;
    }
    try {
      await this.sink.upsertContainers(all);
    } catch (err) {
      recordError('upsertContainers', err);
    }
    return false;
  }

  /** Returns true when the run was cut short and must end. */
  private async refreshPrincipals(
    recordError: RecordError,
    cutShort: (err: unknown) => boolean,
    limits: RunLimits,
  ): Promise<boolean> {
    let page: SourcePrincipal[] = [];
    try {
      for await (const p of this.connector.listPrincipals(limits)) {
        page.push(p);
        if (page.length >= PRINCIPAL_BATCH) {
          await this.sink.upsertPrincipals(page);
          page = [];
        }
      }
      if (page.length > 0) await this.sink.upsertPrincipals(page);
    } catch (err) {
      if (cutShort(err)) return true;
      recordError('listPrincipals', err);
    }
    return false;
  }
}
