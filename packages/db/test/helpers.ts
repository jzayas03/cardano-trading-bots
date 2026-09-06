import { randomBytes } from 'node:crypto';
import pg from 'pg';

export const PG_ENABLED = process.env.RUN_PG_TESTS === '1';

/** Runs `fn` against a fresh schema on the compose database, then drops it. Migrations use unqualified names, so search_path isolates them. */
export async function withTestSchema(fn: (db: pg.Pool) => Promise<void>): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgres://ctb:ctb_local_only@localhost:5433/ctb';
  const schema = `t_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  // Everything that can fail after `admin` exists lives in this try, and the finally below only
  // ends/drops what actually got created — a CREATE SCHEMA failure must still release `admin`,
  // not leak it (reviewer finding F8).
  let schemaCreated = false;
  let db: pg.Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    db = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
    await fn(db);
  } finally {
    if (db) await db.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
