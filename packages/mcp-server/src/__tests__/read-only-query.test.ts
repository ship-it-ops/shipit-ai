import { describe, it, expect, vi, afterEach } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { runReadOnlyQuery, ReadOnlyQueryError } from '../cypher/read-only-query.js';

// A stand-in for the driver at the one boundary this module has: a session, a
// transaction, and a result that is read record by record. What the database
// itself does with a read-access transaction is covered by the api-server's
// integration suite (cypher-query-service.integration.test.ts).
interface FakeGraph {
  keys?: string[];
  /** One array of column values per row. */
  rows?: unknown[][];
  /** beginTransaction rejects with this. */
  beginError?: Error;
  /** The query fails with this once it is run. */
  runError?: Error;
  /** beginTransaction never settles. */
  hangs?: boolean;
  /** Closing a session does not settle until letGo() is called. */
  holdsOn?: boolean;
}

function fakeDriver(graph: FakeGraph = {}) {
  const keys = graph.keys ?? [];
  const rows = graph.rows ?? [];
  const read = { records: 0 };
  const tx = {
    run: vi.fn((_query: string, _params: Record<string, unknown>) => ({
      keys: async () => {
        if (graph.runError) throw graph.runError;
        return keys;
      },
      async *[Symbol.asyncIterator]() {
        for (const fields of rows) {
          read.records++;
          yield new neo4j.types.Record(keys, fields);
        }
      },
    })),
    rollback: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
  };
  const held: Array<() => void> = [];
  const session = {
    beginTransaction: vi.fn((_config: { timeout: number }) => {
      if (graph.hangs) return new Promise(() => {});
      if (graph.beginError) return Promise.reject(graph.beginError);
      return Promise.resolve(tx);
    }),
    close: vi.fn(() =>
      graph.holdsOn ? new Promise<void>((resolve) => held.push(resolve)) : Promise.resolve(),
    ),
  };
  const driver = { session: vi.fn((_config: unknown) => session) };
  return {
    driver: driver as unknown as Driver,
    sessionOf: driver.session,
    session,
    tx,
    read,
    /** The database is done with every query whose session was being closed. */
    letGo: () => held.splice(0).forEach((resolve) => resolve()),
  };
}

const LIMITS = { timeoutMs: 5_000, rowLimit: 100 };

const neo4jError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const node = (id: number, labels: string[], properties: Record<string, unknown> = {}) =>
  new neo4j.types.Node(neo4j.int(id), labels, properties, `4:test:${id}`);

function path(...nodes: Array<ReturnType<typeof node>>) {
  const segments = nodes.slice(1).map((end, i) => {
    const start = nodes[i]!;
    const rel = new neo4j.types.Relationship(
      neo4j.int(100 + i),
      start.identity,
      end.identity,
      'LINKS',
      {},
      `5:test:${100 + i}`,
      start.elementId,
      end.elementId,
    );
    return new neo4j.types.PathSegment(start, rel, end);
  });
  return new neo4j.types.Path(nodes[0]!, nodes[nodes.length - 1]!, segments);
}

describe('runReadOnlyQuery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the query as written, in a read-access transaction that carries the timeout', async () => {
    const { driver, sessionOf, session, tx } = fakeDriver({ keys: ['n'], rows: [[1]] });
    await runReadOnlyQuery(
      driver,
      'MATCH (n) RETURN n LIMIT 5',
      { a: 1 },
      {
        timeoutMs: 1_234,
        rowLimit: 10,
      },
    );
    expect(sessionOf).toHaveBeenCalledWith(expect.objectContaining({ defaultAccessMode: 'READ' }));
    expect(session.beginTransaction).toHaveBeenCalledWith({ timeout: 1_234 });
    expect(tx.run).toHaveBeenCalledWith('MATCH (n) RETURN n LIMIT 5', { a: 1 });
  });

  it('rolls the transaction back and never commits it', async () => {
    const { driver, session, tx } = fakeDriver({ keys: ['n'], rows: [[1]] });
    await runReadOnlyQuery(driver, 'RETURN 1 AS n', {}, LIMITS);
    expect(tx.rollback).toHaveBeenCalledTimes(1);
    expect(tx.commit).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('returns the columns and one object per row', async () => {
    const { driver } = fakeDriver({
      keys: ['name', 'tier'],
      rows: [
        ['api', 1],
        ['web', 2],
      ],
    });
    expect(await runReadOnlyQuery(driver, 'q', {}, LIMITS)).toEqual({
      columns: ['name', 'tier'],
      rows: [
        { name: 'api', tier: 1 },
        { name: 'web', tier: 2 },
      ],
      truncated: false,
      withheld: 0,
    });
  });

  it('stops reading at the row limit and says the result was cut short', async () => {
    const { driver, read } = fakeDriver({
      keys: ['i'],
      rows: Array.from({ length: 50 }, (_, i) => [i]),
    });
    const result = await runReadOnlyQuery(driver, 'q', {}, { timeoutMs: 5_000, rowLimit: 3 });
    expect(result.rows).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    expect(result.truncated).toBe(true);
    // One record past the limit is how it knows there was more.
    expect(read.records).toBe(4);
  });

  it('does not call a result that fits exactly cut short', async () => {
    const { driver } = fakeDriver({ keys: ['i'], rows: [[0], [1], [2]] });
    const result = await runReadOnlyQuery(driver, 'q', {}, { timeoutMs: 5_000, rowLimit: 3 });
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it('asks the database for no more than the row limit and one', async () => {
    const { driver, sessionOf } = fakeDriver();
    await runReadOnlyQuery(driver, 'q', {}, { timeoutMs: 5_000, rowLimit: 3 });
    expect(sessionOf).toHaveBeenCalledWith(expect.objectContaining({ fetchSize: 4 }));
  });

  // The row limit counts rows. A single row can carry a list of any length,
  // so what comes back is also bounded by the number of values in it.
  describe('the size of the result', () => {
    const tooLarge = async (rows: unknown[][], rowLimit = 100): Promise<string> => {
      const { driver, session, tx } = fakeDriver({ keys: ['v'], rows });
      const outcome = await runReadOnlyQuery(driver, 'q', {}, { timeoutMs: 5_000, rowLimit }).then(
        () => 'ran',
        (e: unknown) => (e instanceof ReadOnlyQueryError ? e.kind : 'other'),
      );
      expect(tx.rollback).toHaveBeenCalledTimes(1);
      expect(session.close).toHaveBeenCalledTimes(1);
      return outcome;
    };

    it('refuses a single row that holds more than a hundred thousand values', async () => {
      expect(await tooLarge([[Array.from({ length: 150_000 }, (_, i) => i)]])).toBe('too_large');
    });

    it('refuses rows that hold that many between them', async () => {
      const rows = Array.from({ length: 30 }, () => [Array.from({ length: 5_000 }, (_, i) => i)]);
      expect(await tooLarge(rows)).toBe('too_large');
    });

    it('counts the entries of a map and of what it holds', async () => {
      const wide = Object.fromEntries(Array.from({ length: 60_000 }, (_, i) => [`k${i}`, [i, i]]));
      expect(await tooLarge([[wide]])).toBe('too_large');
    });

    it('lets a result under the budget through', async () => {
      const rows = Array.from({ length: 50 }, () => [Array.from({ length: 1_000 }, (_, i) => i)]);
      expect(await tooLarge(rows)).toBe('ran');
    });
  });

  describe('internal nodes', () => {
    const team = node(1, ['Team'], { name: 'platform' });
    const repo = node(2, ['Repository'], { name: 'api' });
    const token = node(3, ['_AccessToken'], { id: 't' });

    it('withholds an internal node and counts it', async () => {
      const { driver } = fakeDriver({ keys: ['n'], rows: [[team], [token]] });
      const result = await runReadOnlyQuery(driver, 'q', {}, LIMITS);
      expect(result.rows).toEqual([{ n: team }, { n: null }]);
      expect(result.withheld).toBe(1);
    });

    it('withholds a node that carries an internal label among others', async () => {
      const both = node(4, ['Repository', '_LinkingKey']);
      const { driver } = fakeDriver({ keys: ['n'], rows: [[both]] });
      const result = await runReadOnlyQuery(driver, 'q', {}, LIMITS);
      expect(result.rows).toEqual([{ n: null }]);
    });

    it('withholds one inside a list or a map, and leaves the rest of it', async () => {
      const { driver } = fakeDriver({
        keys: ['all', 'byKind'],
        rows: [[[team, token, 7], { catalog: repo, internal: [token], count: 2 }]],
      });
      const result = await runReadOnlyQuery(driver, 'q', {}, LIMITS);
      expect(result.rows).toEqual([
        { all: [team, null, 7], byKind: { catalog: repo, internal: [null], count: 2 } },
      ]);
      expect(result.withheld).toBe(2);
    });

    it('withholds a path that touches one, and keeps a path that does not', async () => {
      const { driver } = fakeDriver({
        keys: ['through', 'clear'],
        rows: [[path(team, token, repo), path(team, repo)]],
      });
      const result = await runReadOnlyQuery(driver, 'q', {}, LIMITS);
      expect(result.rows[0]!.through).toBeNull();
      expect(neo4j.isPath(result.rows[0]!.clear)).toBe(true);
      expect(result.withheld).toBe(1);
    });

    it('leaves the driver values of every other kind as they are', async () => {
      const count = neo4j.int(42);
      const when = new neo4j.types.Date(2026, 10, 5);
      const { driver } = fakeDriver({
        keys: ['count', 'when', 'text'],
        rows: [[count, when, '_x']],
      });
      const result = await runReadOnlyQuery(driver, 'q', {}, LIMITS);
      expect(result.rows[0]!.count).toBe(count);
      expect(result.rows[0]!.when).toBe(when);
      expect(result.rows[0]!.text).toBe('_x');
      expect(result.withheld).toBe(0);
    });
  });

  // The timeout ends a query between rows. Work inside one row runs on in the
  // database after the caller has its answer, so the number of queries a driver
  // carries at once is limited, and a place is held until the database is done.
  describe('how many run at once', () => {
    const kindOf = (outcome: unknown): string =>
      outcome instanceof ReadOnlyQueryError ? outcome.kind : 'ran';
    const start = (driver: Driver) =>
      runReadOnlyQuery(driver, 'q', {}, LIMITS).catch((e: unknown) => e);

    it('runs four for one driver and refuses the fifth without opening a session', async () => {
      vi.useFakeTimers();
      const { driver, sessionOf } = fakeDriver({ hangs: true });
      const four = [start(driver), start(driver), start(driver), start(driver)];
      expect(kindOf(await start(driver))).toBe('busy');
      expect(sessionOf).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 1_000);
      expect((await Promise.all(four)).map(kindOf)).toEqual([
        'timeout',
        'timeout',
        'timeout',
        'timeout',
      ]);
    });

    it('holds a place until the database has let go, not until the caller has its answer', async () => {
      vi.useFakeTimers();
      const { driver, sessionOf, letGo } = fakeDriver({ hangs: true, holdsOn: true });
      const four = [start(driver), start(driver), start(driver), start(driver)];
      await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 1_000);
      await Promise.all(four);

      // All four callers were answered, and the database is still busy with them.
      expect(kindOf(await start(driver))).toBe('busy');
      expect(sessionOf).toHaveBeenCalledTimes(4);

      letGo();
      await vi.advanceTimersByTimeAsync(0);
      const next = start(driver);
      await vi.advanceTimersByTimeAsync(0);
      expect(sessionOf).toHaveBeenCalledTimes(5);

      await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 1_000);
      await next;
      letGo();
    });

    it('gives the place back when a query ends, whichever way', async () => {
      const failing = fakeDriver({
        runError: neo4jError('Neo.ClientError.Statement.SyntaxError', 'bad'),
      });
      for (let i = 0; i < 6; i++) expect(kindOf(await start(failing.driver))).toBe('failed');

      const unreachable = fakeDriver({ beginError: neo4jError('ServiceUnavailable', 'down') });
      for (let i = 0; i < 6; i++) expect(kindOf(await start(unreachable.driver))).toBe('failed');

      const fine = fakeDriver({ keys: ['n'], rows: [[1]] });
      for (let i = 0; i < 6; i++) expect(kindOf(await start(fine.driver))).toBe('ran');
    });

    it('counts each driver by itself', async () => {
      vi.useFakeTimers();
      const full = fakeDriver({ hangs: true });
      const four = [start(full.driver), start(full.driver), start(full.driver), start(full.driver)];
      const other = fakeDriver({ keys: ['n'], rows: [[1]] });
      expect(kindOf(await start(other.driver))).toBe('ran');

      await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 1_000);
      await Promise.all(four);
    });
  });

  describe('failures', () => {
    const failure = async (graph: FakeGraph): Promise<ReadOnlyQueryError> => {
      const { driver } = fakeDriver(graph);
      const error = await runReadOnlyQuery(driver, 'q', {}, LIMITS).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReadOnlyQueryError);
      return error as ReadOnlyQueryError;
    };

    it('reports a write the database refused as a refused write', async () => {
      const error = await failure({
        runError: neo4jError(
          'Neo.ClientError.Statement.AccessMode',
          'Writing in read access mode not allowed. Attempted write to neo4j',
        ),
      });
      expect(error.kind).toBe('write_refused');
    });

    it('reports a transaction the database ended for running too long as a timeout', async () => {
      const error = await failure({
        runError: neo4jError(
          'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration',
          'The transaction has not completed within the timeout specified at its start by the client.',
        ),
      });
      expect(error.kind).toBe('timeout');
    });

    it("passes any other failure on with the database's message", async () => {
      const error = await failure({
        runError: neo4jError('Neo.ClientError.Statement.SyntaxError', "Invalid input 'RETURN'"),
      });
      expect(error.kind).toBe('failed');
      expect(error.message).toBe("Invalid input 'RETURN'");
    });

    it('rolls back and closes the session when the query fails', async () => {
      const { driver, session, tx } = fakeDriver({
        runError: neo4jError('Neo.ClientError.Statement.SyntaxError', 'bad'),
      });
      await runReadOnlyQuery(driver, 'q', {}, LIMITS).catch(() => {});
      expect(tx.rollback).toHaveBeenCalledTimes(1);
      expect(tx.commit).not.toHaveBeenCalled();
      expect(session.close).toHaveBeenCalledTimes(1);
    });

    it('closes the session when the transaction cannot be opened', async () => {
      const { driver, session } = fakeDriver({
        beginError: neo4jError('ServiceUnavailable', 'Connection refused'),
      });
      const error = await runReadOnlyQuery(driver, 'q', {}, LIMITS).catch((e: unknown) => e);
      expect((error as ReadOnlyQueryError).kind).toBe('failed');
      expect(session.close).toHaveBeenCalledTimes(1);
    });

    it('gives up by itself, a little after the timeout, when the database does not answer', async () => {
      vi.useFakeTimers();
      const { driver, session } = fakeDriver({ hangs: true });
      const outcome = runReadOnlyQuery(driver, 'q', {}, { timeoutMs: 1_000, rowLimit: 10 }).catch(
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(session.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      const error = (await outcome) as ReadOnlyQueryError;
      expect(error).toBeInstanceOf(ReadOnlyQueryError);
      expect(error.kind).toBe('timeout');
      expect(session.close).toHaveBeenCalledTimes(1);
    });
  });
});
