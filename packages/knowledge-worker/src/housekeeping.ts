// The worker's two periodic chores beside indexing: deleting the content of
// containers an admin deselected (spec §API: "Deselecting requests a purge"),
// and removing tombstones past their retention. Neither may take the process
// down: a failure is logged and the next tick tries again.
import type { KnowledgeStore } from '@shipit-ai/knowledge';

export interface HousekeepingOptions {
  store: Pick<KnowledgeStore, 'purgeBatch' | 'sweepUnusedPrincipals' | 'deleteTombstonesOlderThan'>;
  /** knowledge.retention.tombstoneDays. */
  tombstoneDays: number;
  /** How often deselected containers are purged. Default one minute. */
  purgeEveryMs?: number;
  /** How often old tombstones are removed. Default one day. */
  tombstonesEveryMs?: number;
  log: (line: string) => void;
  /** Defaults to `log`. */
  logError?: (line: string) => void;
}

const MINUTE_MS = 60_000;
/** Containers per purge transaction, and the most transactions in one tick. */
const PURGE_BATCH = 20;
const MAX_PURGE_BATCHES = 50;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function startHousekeeping(options: HousekeepingOptions): { stop(): void } {
  const logError = options.logError ?? options.log;

  // Small batches: a purge must not hold a transaction open for long beside
  // the indexing loop. But batch after batch within one tick, until one comes
  // back short: one batch a minute left a deleted connector with a few hundred
  // containers around for hours, and every other deselect queued behind it.
  const purge = async (): Promise<void> => {
    try {
      let removed = 0;
      for (let batch = 0; batch < MAX_PURGE_BATCHES; batch++) {
        const done = await options.store.purgeBatch(PURGE_BATCH);
        removed += done.documents;
        if (done.containers < PURGE_BATCH) break;
      }
      if (removed > 0) options.log(`purged ${removed} document(s)`);
    } catch (err) {
      logError(`purge failed: ${(err as Error).message}`);
    }
    try {
      const people = await options.store.sweepUnusedPrincipals();
      if (people > 0) options.log(`removed ${people} unused principal(s)`);
    } catch (err) {
      logError(`principal sweep failed: ${(err as Error).message}`);
    }
  };
  const tombstones = async (): Promise<void> => {
    try {
      const removed = await options.store.deleteTombstonesOlderThan(options.tombstoneDays);
      if (removed > 0) options.log(`removed ${removed} tombstone(s)`);
    } catch (err) {
      logError(`tombstone cleanup failed: ${(err as Error).message}`);
    }
  };

  void tombstones();
  void purge();
  const purgeTimer = setInterval(() => void purge(), options.purgeEveryMs ?? MINUTE_MS);
  const tombstoneTimer = setInterval(() => void tombstones(), options.tombstonesEveryMs ?? DAY_MS);
  // The indexing loop keeps the process alive; these must not.
  purgeTimer.unref?.();
  tombstoneTimer.unref?.();

  return {
    stop(): void {
      clearInterval(purgeTimer);
      clearInterval(tombstoneTimer);
    },
  };
}
