import pg from 'pg';

export type Db = pg.Pool;

/**
 * The narrow slice of `pg` a repository actually uses. A `Pool` and a checked-out `PoolClient` both
 * satisfy it, which is what lets one repository class run either on the pool (autocommit, one
 * statement at a time) or bound to a single client inside a transaction.
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Wait this long for a connection before failing. pg's default is 0 — wait forever (finding M4). */
const CONNECT_TIMEOUT_MS = 10_000;
/** Cap on one statement, enforced twice: server-side (`statement_timeout`, so the backend actually
 * cancels the query rather than leaving it running behind an abandoned client) and client-side
 * (`query_timeout`, so a wedged connection that never answers still rejects locally). */
const STATEMENT_TIMEOUT_MS = 30_000;

/**
 * One pool per process. `onError` receives idle-client errors so they never crash the process silently.
 *
 * Finding M4: every bound but `max` used to be pg's default, and pg's default connect timeout is
 * "wait forever". In a long-lived paper run an unbounded await never throws, so the commit sink's
 * retry never fires and its catch never runs: the run stops writing while `runs.status` still says
 * `running` and only the heartbeat betrays it. Bounded here so a stuck connection or statement
 * surfaces as an error something can act on.
 */
export function createPool(databaseUrl: string, onError: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
  });
  pool.on('error', onError);
  return pool;
}

/**
 * Runs `fn` on one checked-out client inside BEGIN/COMMIT, ROLLBACK on any error, release in a
 * `finally` so the client goes back to the pool on every path. Everything `fn` does through the
 * `Queryable` it is handed is part of the same transaction — that is what makes a multi-chunk bulk
 * insert all-or-nothing (finding C1).
 */
export async function withTransaction<T>(db: Db, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // intentional: the original error is the one worth reporting; a ROLLBACK that itself fails
      // (the connection is already dead) must not replace it with a less informative message.
    }
    throw err;
  } finally {
    client.release();
  }
}
