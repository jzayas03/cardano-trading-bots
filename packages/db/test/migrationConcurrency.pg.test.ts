import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/index.js';
import { PG_ENABLED } from './helpers.js';

const URL = process.env.DATABASE_URL ?? 'postgres://ctb:ctb_local_only@localhost:5433/ctb';
const CONCURRENCY = 8;

/**
 * Migration 0006 creates a CLUSTER-wide role while its grants are schema-scoped, so it runs once per
 * schema and many schemas migrate at the same time: vitest runs the pg tests in parallel workers,
 * each against its own throwaway schema. A check-then-create (`IF NOT EXISTS ... THEN CREATE ROLE`)
 * is not atomic across sessions — every session sees "not exists", they all issue CREATE ROLE, one
 * wins, and the rest die on the pg_authid unique index. Measured before the fix: 7 of 8 concurrent
 * runs failed. CI caught it on a fresh cluster; a developer machine passed, because the role already
 * existed there from an earlier run and the create path was never taken.
 *
 * This test runs the REAL migration text concurrently, with the role name rewritten to a unique
 * throwaway so it exercises the create path every time without dropping the shared `ctb_dashboard`
 * (which other workers' schemas hold grants on, and which would make this test flaky in exactly the
 * way it exists to prevent).
 */
describe.skipIf(!PG_ENABLED)('migration 0006 under concurrency', () => {
  it('creates its role from many sessions at once without a duplicate-key failure', async () => {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, '0006_dashboard_role.sql'), 'utf8');
    const role = `ctb_dash_test_${randomBytes(4).toString('hex')}`;
    const text = sql.replaceAll('ctb_dashboard', role);
    expect(text, 'the role name must actually have been substituted').toContain(role);

    const admin = new pg.Pool({ connectionString: URL, max: 2 });
    const schemas = Array.from({ length: CONCURRENCY }, () => `c_${randomBytes(4).toString('hex')}`);
    const pools: pg.Pool[] = [];
    try {
      for (const s of schemas) await admin.query(`CREATE SCHEMA ${s}`);
      for (const s of schemas) pools.push(new pg.Pool({ connectionString: URL, max: 1, options: `-c search_path=${s}` }));
      const results = await Promise.allSettled(pools.map((p) => p.query(text)));
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected.map((r) => String(r.reason)), `${rejected.length} of ${CONCURRENCY} concurrent runs failed`).toEqual([]);
    } finally {
      for (const p of pools) await p.end();
      for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });
});
