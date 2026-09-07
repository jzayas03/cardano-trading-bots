import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS_DIR } from '../src/index.js';
import { PG_ENABLED, withTestSchema } from './helpers.js';

describe.skipIf(!PG_ENABLED)('ctb_dashboard role', () => {
  it('can SELECT from every table in the schema and cannot INSERT, UPDATE, DELETE or DDL', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const schema = (await db.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
      const url = new URL(process.env.DATABASE_URL ?? 'postgres://ctb:ctb_local_only@localhost:5433/ctb');
      url.username = 'ctb_dashboard'; url.password = 'ctb_dashboard_local_only';
      const ro = new pg.Pool({ connectionString: url.toString(), max: 1, options: `-c search_path=${schema}` });
      try {
        for (const t of ['tokens', 'collector_runs', 'pool_snapshots', 'candles', 'candles_external', 'external_pool_map', 'runs', 'paper_orders', 'run_equity', 'schema_migrations']) {
          await expect(ro.query(`SELECT count(*) FROM ${t}`), t).resolves.toBeDefined();
        }
        await expect(ro.query("INSERT INTO tokens VALUES ('u','p','a','A',0,'Meme','2026-09-05','t')")).rejects.toThrow(/permission denied/);
        await expect(ro.query('DELETE FROM runs')).rejects.toThrow(/permission denied/);
        await expect(ro.query('UPDATE runs SET status = $1', ['finished'])).rejects.toThrow(/permission denied/);
        await expect(ro.query('CREATE TABLE x (a int)')).rejects.toThrow(/permission denied/);
        // default privileges: a table created after the migration is readable too
        await db.query('CREATE TABLE later_table (a int)');
        await expect(ro.query('SELECT count(*) FROM later_table')).resolves.toBeDefined();
      } finally {
        await ro.end();
      }
    });
  });

  it('is idempotent: applying the raw migration SQL twice in one schema never fails', async () => {
    // migrate() itself skips a file it has already recorded in schema_migrations, so calling it
    // twice in one schema would never actually re-execute 0006's SQL and would prove nothing about
    // the SQL's own idempotence. This runs the migration's file contents directly, twice, to prove
    // the DO block tolerates a role and grants that already exist — the real-world condition every
    // throwaway test schema after the first one (and the dev database on a second `npm run
    // migrate`) hits, since ctb_dashboard is a cluster-wide role that persists across schemas.
    await withTestSchema(async (db) => {
      await migrate(db);
      const sql = await readFile(path.join(MIGRATIONS_DIR, '0006_dashboard_role.sql'), 'utf8');
      await expect(db.query(sql)).resolves.toBeDefined();
    });
  });
});
