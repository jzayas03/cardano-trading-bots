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

/** One pool per process. `onError` receives idle-client errors so they never crash the process silently. */
export function createPool(databaseUrl: string, onError: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
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
