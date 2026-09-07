/**
 * Read only (spec §3): every query the dashboard issues is `SELECT`/`WITH` only. This is a runtime
 * guard, not a source-text grep — it records the SQL text every dashboard read path ACTUALLY issues
 * (`PgDashboardReads.listRuns` across every filter combination, and `PgRunRepo.getRun` /
 * `listOrders` / `listEquity`, the three `RunRepo` methods the detail page uses) and asserts each one
 * matches `/^\s*(SELECT|WITH)\b/i` and contains none of `INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|
 * TRUNCATE` anywhere, even inside a string literal.
 *
 * Proved red on 2026-09-07 by temporarily adding `DELETE FROM runs` as a second statement `listRuns`
 * issued after its real SELECT — the assertion caught it immediately, both on the "not a SELECT
 * prefix" check (fails: `DELETE` is not `SELECT`, it isn't even reached because it's a second call
 * from a different code path in this test, so a more faithful reproduction is folding the DELETE
 * into the SAME string via a semicolon, e.g. `SELECT 1; DELETE FROM runs`) and on the forbidden-
 * keyword check. Reverted afterwards — see the task report for the exact diff and failure output.
 */
import type pg from 'pg';
import { PgRunRepo } from '@ctb/engine';
import type { Queryable } from '@ctb/db';
import { describe, expect, it } from 'vitest';
import { PgDashboardReads } from '../src/reads.js';

class RecordingQueryable implements Queryable {
  readonly statements: string[] = [];

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
    this.statements.push(text);
    return { rows: [] as R[], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as pg.QueryResult<R>;
  }
}

const READ_ONLY_PREFIX = /^\s*(SELECT|WITH)\b/i;
const FORBIDDEN_KEYWORD = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i;

describe('dashboard read-only guard', () => {
  it('every SQL statement PgDashboardReads.listRuns and the RunRepo methods the detail page uses issue is SELECT/WITH only', async () => {
    const rec = new RecordingQueryable();
    const reads = new PgDashboardReads(rec);
    // `PgRunRepo`'s constructor is `(db: Db, q?: Queryable)`; passing the same recorder as both means
    // `getRun`/`listOrders`/`listEquity` (the only three methods this guard exercises — `insertOrders`,
    // the one method that branches on `this.q === this.db`, is never called here) route every query
    // through it.
    const runs = new PgRunRepo(rec as unknown as pg.Pool, rec);

    await reads.listRuns({}, 10, 0);
    await reads.listRuns({ mode: 'paper' }, 10, 0);
    await reads.listRuns({ mode: 'backtest' }, 10, 0);
    await reads.listRuns({ strategy: 'ma-crossover' }, 10, 0);
    await reads.listRuns({ unit: 'abcd' }, 10, 0);
    await reads.listRuns({ status: 'running' }, 10, 0);
    await reads.listRuns({ status: 'finished' }, 10, 0);
    await reads.listRuns({ status: 'aborted' }, 10, 0);
    await reads.listRuns({ mode: 'paper', strategy: 'ma-crossover', unit: 'abcd', status: 'running' }, 10, 0);
    await reads.listRuns({}, 9999, -5); // clamp/negative-offset path

    await runs.getRun(1);
    await runs.listOrders(1);
    await runs.listEquity(1, new Date(0), new Date());

    expect(rec.statements.length).toBeGreaterThan(10);
    for (const sql of rec.statements) {
      expect(sql, `not SELECT/WITH: ${sql}`).toMatch(READ_ONLY_PREFIX);
      expect(sql, `contains a forbidden keyword: ${sql}`).not.toMatch(FORBIDDEN_KEYWORD);
    }
  });
});
