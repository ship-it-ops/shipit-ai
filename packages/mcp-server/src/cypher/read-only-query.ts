// How a query that a caller wrote is run.
//
// The Query Playground (api-server) and the graph_query tool both run it
// through this one function, after the text has passed checkReadOnlyCypher in
// @shipit-ai/shared. That check reads text; this is the part that does not
// depend on reading it right:
//
//  - The transaction is opened for read access, so the database itself refuses
//    a write, and it is always rolled back, never committed.
//  - The timeout travels with the transaction, so the database ends a query
//    that runs too long, whatever the caller does.
//  - Rows are read one at a time and reading stops at the limit. The query's
//    own LIMIT cannot raise it, and nothing past it is held in memory. A
//    result is also bounded by the number of values in it, since one row can
//    carry a list of any length.
//  - An internal node, or a path through one, comes back as null.
//  - A driver carries a few of these queries at a time, and refuses the rest.
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { isInternalLabel } from '@shipit-ai/shared';

export interface ReadOnlyQueryLimits {
  /** The database ends the transaction after this long. */
  timeoutMs: number;
  /** At most this many rows are read, whatever the query asks for. */
  rowLimit: number;
}

export interface ReadOnlyQueryResult {
  columns: string[];
  /** One object per row, keyed by column, holding the driver's own values. */
  rows: Array<Record<string, unknown>>;
  /** The query had more rows than the limit. */
  truncated: boolean;
  /** How many values were withheld because they were, or passed through, an internal node. */
  withheld: number;
}

export type ReadOnlyQueryFailure =
  /** As many queries as one driver carries at a time are already running. */
  | 'busy'
  /** The result holds more values than a result may. */
  | 'too_large'
  /** The query ran past its timeout. */
  | 'timeout'
  /** The database refused the query because it writes. */
  | 'write_refused'
  /** Anything else: a syntax error, an unknown name, a lost connection. */
  | 'failed';

/** Every failure of runReadOnlyQuery. The message is fit to show the caller. */
export class ReadOnlyQueryError extends Error {
  readonly kind: ReadOnlyQueryFailure;

  constructor(kind: ReadOnlyQueryFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReadOnlyQueryError';
    this.kind = kind;
  }
}

// How long past the timeout to wait for the database to end the transaction
// itself (it checks on an interval) before giving up on it from this side.
const GRACE_MS = 500;

// The driver's own page size. A higher row limit is read in pages of this.
const MAX_FETCH_SIZE = 1000;

// The most values a result may hold, counting every row, list item and map
// entry (a node or a path counts as one). The driver has to receive a whole
// row before this sees it, so the bound is on what goes on from here: the
// response, and whatever reads it.
const MAX_VALUES = 100_000;

// How many caller-written queries one driver carries at a time. The database
// ends a query that is past its timeout between rows; work inside a single row
// runs on after the caller has been answered. The limit keeps such queries from
// adding up, on the database and in the driver's connection pool: a place is
// held until the session has closed, which is when the database has let go.
const MAX_CONCURRENT = 4;
const running = new WeakMap<Driver, number>();

const WRITE_IN_READ_TRANSACTION = 'Neo.ClientError.Statement.AccessMode';

const timeoutMessage = (timeoutMs: number): string => `Query exceeded the ${timeoutMs} ms timeout.`;

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function isOrPassesThroughInternalNode(value: unknown): boolean {
  const internal = (labels: string[]): boolean => labels.some(isInternalLabel);
  if (neo4j.isNode(value)) return internal(value.labels);
  if (neo4j.isPath(value)) {
    return (
      internal(value.start.labels) || value.segments.some((segment) => internal(segment.end.labels))
    );
  }
  return false;
}

interface Tally {
  withheld: number;
  values: number;
}

/** `value` with every internal node, and every path through one, replaced by null. */
function withoutInternalNodes(value: unknown, tally: Tally): unknown {
  tally.values++;
  if (isOrPassesThroughInternalNode(value)) {
    tally.withheld++;
    return null;
  }
  if (Array.isArray(value)) return value.map((item) => withoutInternalNodes(item, tally));
  if (isPlainMap(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withoutInternalNodes(item, tally)]),
    );
  }
  return value;
}

async function readRows(
  session: Session,
  cypher: string,
  params: Record<string, unknown>,
  { timeoutMs, rowLimit }: ReadOnlyQueryLimits,
): Promise<ReadOnlyQueryResult> {
  const tx = await session.beginTransaction({ timeout: timeoutMs });
  try {
    const result = tx.run(cypher, params);
    const columns = (await result.keys()).map(String);
    const rows: Array<Record<string, unknown>> = [];
    const tally: Tally = { withheld: 0, values: 0 };
    let truncated = false;
    for await (const record of result) {
      // One record past the limit says there was more. Leaving the loop tells
      // the driver to discard the rest.
      if (rows.length === rowLimit) {
        truncated = true;
        break;
      }
      rows.push(
        Object.fromEntries(
          columns.map((column) => [column, withoutInternalNodes(record.get(column), tally)]),
        ),
      );
      if (tally.values > MAX_VALUES) {
        throw new ReadOnlyQueryError(
          'too_large',
          `The result holds more than ${MAX_VALUES.toLocaleString('en-US')} values. Return fewer rows, or smaller lists and maps.`,
        );
      }
    }
    return { columns, rows, truncated, withheld: tally.withheld };
  } finally {
    // Rolled back on every path and committed on none: a read leaves nothing
    // to keep, and a transaction that is never committed changes nothing.
    await tx.rollback().catch(() => {});
  }
}

function toReadOnlyQueryError(err: unknown, timeoutMs: number): ReadOnlyQueryError {
  if (err instanceof ReadOnlyQueryError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.includes('TransactionTimedOut')) {
    return new ReadOnlyQueryError('timeout', timeoutMessage(timeoutMs), { cause: err });
  }
  if (code === WRITE_IN_READ_TRANSACTION) {
    return new ReadOnlyQueryError(
      'write_refused',
      'The database refused the query because it writes. Raw queries are read-only.',
      { cause: err },
    );
  }
  return new ReadOnlyQueryError('failed', err instanceof Error ? err.message : String(err), {
    cause: err,
  });
}

/**
 * Runs a caller-written query for reading only. Check the text with
 * checkReadOnlyCypher first: this refuses writes, not everything that check does.
 *
 * @throws ReadOnlyQueryError on every failure.
 */
export async function runReadOnlyQuery(
  driver: Driver,
  cypher: string,
  params: Record<string, unknown>,
  limits: ReadOnlyQueryLimits,
): Promise<ReadOnlyQueryResult> {
  const inFlight = running.get(driver) ?? 0;
  if (inFlight >= MAX_CONCURRENT) {
    throw new ReadOnlyQueryError(
      'busy',
      'Too many raw queries are running at the moment. Try again shortly.',
    );
  }
  running.set(driver, inFlight + 1);
  const leave = (): void => {
    running.set(driver, (running.get(driver) ?? 1) - 1);
  };

  let session: Session | undefined;
  let timer: NodeJS.Timeout | undefined;
  let gaveUp = false;
  try {
    session = driver.session({
      defaultAccessMode: neo4j.session.READ,
      fetchSize: Math.min(limits.rowLimit + 1, MAX_FETCH_SIZE),
    });
    const reading = readRows(session, cypher, params, limits);
    // If the timer wins the race below, nobody is left to hear `reading` fail.
    reading.catch(() => {});
    const givingUp = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        gaveUp = true;
        reject(new ReadOnlyQueryError('timeout', timeoutMessage(limits.timeoutMs)));
      }, limits.timeoutMs + GRACE_MS);
    });
    return await Promise.race([reading, givingUp]);
  } catch (err) {
    throw toReadOnlyQueryError(err, limits.timeoutMs);
  } finally {
    clearTimeout(timer);
    // Closing ends whatever the session still has open, and settles once the
    // database is done with it: only then is this query's place free. After
    // giving up there is no telling how long that takes, so the caller is not
    // kept waiting for it.
    const closing = Promise.resolve(session?.close())
      .catch(() => {})
      .finally(leave);
    if (!gaveUp) await closing;
  }
}
