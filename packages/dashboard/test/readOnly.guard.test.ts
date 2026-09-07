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
 *
 * Finding I1 (review round 1): the call list above is hand-written, so a NEW method added to
 * `PgDashboardReads` is simply never called here and the guard stays green — a reviewer proved this
 * by adding `async purgeRuns() { await this.q.query('DELETE FROM runs'); }` to the class. The second
 * `it` below closes that: it enumerates `PgDashboardReads.prototype`'s own method names at runtime and
 * asserts the set is EXACTLY the set this file exercises above. Adding any method — read or write —
 * fails this assertion until its name is added to `EXERCISED_METHODS` *and* a call to it is added
 * above that proves it SELECT/WITH-only; a write method can never clear both bars at once.
 */
import type pg from 'pg';
import { PgRunRepo } from '@ctb/engine';
import type { Queryable } from '@ctb/db';
import { describe, expect, it } from 'vitest';
import { PgDashboardReads } from '../src/reads.js';

class RecordingQueryable implements Queryable {
  readonly statements: string[] = [];
  /** Finding I2: the previous version of this recorder discarded the bound parameters, so nothing
   * anywhere ever checked what `listRuns` actually sent as `LIMIT`/`OFFSET` — a `9999`-row request
   * being silently accepted and a real `500` clamp being silently deleted looked identical to every
   * test in the suite (`reads.pg.test.ts`'s own clamp case only ever had 3 rows in its schema, so it
   * could not tell "clamped to 500" apart from "not clamped at all"). Recording `values` alongside
   * `text` lets a test assert the actual bound number, not just a row count that a small fixture can't
   * distinguish. */
  readonly calls: Array<{ text: string; values: unknown[] }> = [];

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<pg.QueryResult<R>> {
    this.statements.push(text);
    this.calls.push({ text, values });
    return { rows: [] as R[], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as pg.QueryResult<R>;
  }
}

const READ_ONLY_PREFIX = /^\s*(SELECT|WITH)\b/i;
const FORBIDDEN_KEYWORD = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i;

/** Every `PgDashboardReads` method this file actually drives through the recorder above. */
const EXERCISED_METHODS = new Set(['listRuns']);

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

  // Finding I2: `reads.pg.test.ts`'s `listRuns({}, 9999, 0)` case only ever runs against a 3-row test
  // schema, so it returns the same 3 rows whether the clamp is applied or the whole clamp is deleted —
  // it asserts row count, which cannot distinguish "clamped to 500" from "not clamped at all". This
  // proves the actual bound `LIMIT`/`OFFSET` parameter instead, with no database at all: for `filter =
  // {}` the WHERE clause adds no parameters, so `values` is always exactly `[limit, offset]`.
  it('clamps the bound LIMIT parameter to [1, 500] — proven against the actual parameter value, not a row count (I2)', async () => {
    const rec = new RecordingQueryable();
    const reads = new PgDashboardReads(rec);

    await reads.listRuns({}, 9999, 0);
    expect(rec.calls.at(-1)!.values).toEqual([500, 0]);

    await reads.listRuns({}, 0, 0);
    expect(rec.calls.at(-1)!.values).toEqual([1, 0]);

    await reads.listRuns({}, 500, 0);
    expect(rec.calls.at(-1)!.values).toEqual([500, 0]);

    await reads.listRuns({}, 1, 0);
    expect(rec.calls.at(-1)!.values).toEqual([1, 0]);
  });

  it('exercises every PgDashboardReads prototype method (I1) — a method added to the class must be added here, and driven above, before this passes again', () => {
    const actual = new Set(
      Object.getOwnPropertyNames(PgDashboardReads.prototype).filter((name) => name !== 'constructor'),
    );
    expect(
      actual,
      'PgDashboardReads.prototype has a method this guard does not know about — a new method (read or ' +
        'write) is invisible to the SELECT/WITH check above until it is added to EXERCISED_METHODS and ' +
        'a call to it is added to the test that drives the recorder',
    ).toEqual(EXERCISED_METHODS);
  });
});
