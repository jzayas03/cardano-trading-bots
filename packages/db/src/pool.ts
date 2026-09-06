import pg from 'pg';

export type Db = pg.Pool;

/** One pool per process. `onError` receives idle-client errors so they never crash the process silently. */
export function createPool(databaseUrl: string, onError: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  pool.on('error', onError);
  return pool;
}
