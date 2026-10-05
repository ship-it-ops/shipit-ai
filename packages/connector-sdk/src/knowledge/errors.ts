// Two things that end a container's turn, or a whole run, without being
// failures. Both are recognised by a `code`, not by `instanceof`, so they
// survive a second copy of this module in a bundle.

const CONTAINER_CHANGED = 'KNOWLEDGE_CONTAINER_CHANGED';
const RUN_CUT_SHORT = 'KNOWLEDGE_RUN_CUT_SHORT';

/**
 * Thrown by a sink when the container is no longer the one the run started
 * with: an admin deselected it, or it was purged and selected again, since the
 * run read its checkpoint. Storing the batch would refill what was deleted, or
 * write a stale checkpoint over a fresh backfill. The harness skips the
 * container; the next run reads it afresh.
 */
export class KnowledgeContainerChanged extends Error {
  readonly code = CONTAINER_CHANGED;
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeContainerChanged';
  }
}

/**
 * Thrown by a connector when the source asks it to wait longer than the run
 * has left (a rate limit). The harness ends the run there: it is not a
 * failure, and the next run resumes from the checkpoints. `note` lands on the
 * run record.
 */
export class KnowledgeRunCutShort extends Error {
  readonly code = RUN_CUT_SHORT;
  constructor(
    readonly note: string,
    message?: string,
  ) {
    super(message ?? note);
    this.name = 'KnowledgeRunCutShort';
  }
}

const codeOf = (err: unknown): unknown => ((err ?? {}) as { code?: unknown }).code;

export function isContainerChanged(err: unknown): err is KnowledgeContainerChanged {
  return codeOf(err) === CONTAINER_CHANGED;
}

export function isRunCutShort(err: unknown): err is KnowledgeRunCutShort {
  return codeOf(err) === RUN_CUT_SHORT;
}
