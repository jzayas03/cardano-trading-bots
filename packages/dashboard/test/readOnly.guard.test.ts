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
 * by adding `async purgeRuns() { await this.q.query('DELETE FROM runs'); }` to the class. Round 1's
 * fix added an `EXERCISED_METHODS` set and asserted `PgDashboardReads.prototype`'s own method names
 * equalled it exactly — but that is a NAME check, not a call. A second review round proved a name-list
 * can be satisfied without ever running the method: adding `'purgeRuns'` to `EXERCISED_METHODS` (one
 * word) turned the guard green while `purgeRuns` itself was never invoked, so its `DELETE` never
 * reached the recorder and the SELECT/WITH check never saw it. The claim in round 1's comment — "a
 * write method can never clear both bars at once" — was false as written: the two bars were "is its
 * name in the set" and "is every RECORDED statement clean", and a method that is never called adds no
 * statement to check, so it can't fail a check it never reaches.
 *
 * `EXERCISED_METHODS` is gone. The second `it` below instead REFLECTIVELY INVOKES every one of
 * `PgDashboardReads.prototype`'s own method names against the recorder, using `GENERIC_SAFE_ARGS`
 * sliced to each method's declared arity — there is no longer a list a reviewer can edit by hand
 * without also making the method run.
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

/**
 * One fixed argument list used to invoke EVERY `PgDashboardReads.prototype` method reflectively,
 * sliced to each method's declared arity (`Function.prototype.length`). Chosen to be exactly what
 * `listRuns(filter, limit, offset)` needs today (an empty filter object, a positive limit, a zero
 * offset) and a plausible-enough shape for a future read method (an object for a filter-shaped
 * parameter, small numbers for anything limit/offset/id-shaped). No runtime reflection can recover a
 * method's real parameter TYPES, so this is deliberately generic, not tailored — see the note on the
 * reflective test below for what happens when a method's body cannot tolerate that.
 */
const GENERIC_SAFE_ARGS: readonly unknown[] = [{}, 1, 0];

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

  /**
   * Finding I1, round 2: reflectively CALLS every `PgDashboardReads.prototype` method — not merely
   * enumerates its name — against a fresh recorder, then runs the same SELECT/WITH check over every
   * statement that invocation produced. There is no name-list to satisfy by editing text: a method
   * only passes by actually running and issuing nothing but SELECT/WITH.
   *
   * A method whose body throws (or whose returned promise rejects) when given `GENERIC_SAFE_ARGS` is
   * NOT skipped — the test fails loudly, by name, with the args that were tried. That failure is the
   * intended outcome for a method this generic invocation genuinely cannot drive (e.g. one that calls
   * a string-only method on what should have been a string): it tells whoever added the method to give
   * it an explicit, correctly-typed call, the same way `listRuns` already gets one in the `it` above —
   * never to weaken or special-case this test to make the failure go away.
   */
  it('reflectively invokes every PgDashboardReads prototype method and asserts everything it issues is SELECT/WITH only (I1) — a method can no longer pass by being named and never called', async () => {
    const rec = new RecordingQueryable();
    const reads = new PgDashboardReads(rec);
    const methodNames = Object.getOwnPropertyNames(PgDashboardReads.prototype).filter((name) => name !== 'constructor');
    expect(methodNames.length, 'PgDashboardReads has no methods at all — this test would vacuously pass, which is itself a bug').toBeGreaterThan(0);

    // Cast once, to a generic callable-by-name shape — there is no way to type an arbitrary FUTURE
    // method on this interface, and that is exactly why this test exists.
    const callable = reads as unknown as Record<string, (...args: unknown[]) => unknown>;

    for (const name of methodNames) {
      const method = callable[name];
      if (typeof method !== 'function') throw new Error(`PgDashboardReads.${name} is not callable — the prototype has a non-method own property named ${name}`);
      const args = GENERIC_SAFE_ARGS.slice(0, method.length);
      let result: unknown;
      try {
        result = method.apply(reads, args);
      } catch (err) {
        throw new Error(
          `PgDashboardReads.${name} threw when invoked generically with ${JSON.stringify(args)} — give it an ` +
            `explicit, correctly-typed invocation in this test instead of relying on the generic one: ${String(err)}`,
        );
      }
      if (result instanceof Promise) {
        await result.catch((err: unknown) => {
          throw new Error(
            `PgDashboardReads.${name} rejected when invoked generically with ${JSON.stringify(args)} — give it an ` +
              `explicit, correctly-typed invocation in this test instead of relying on the generic one: ${String(err)}`,
          );
        });
      }
    }

    expect(rec.statements.length, 'no PgDashboardReads method issued any query — the reflective invocation above found nothing to check').toBeGreaterThan(0);
    for (const sql of rec.statements) {
      expect(sql, `not SELECT/WITH: ${sql}`).toMatch(READ_ONLY_PREFIX);
      expect(sql, `contains a forbidden keyword: ${sql}`).not.toMatch(FORBIDDEN_KEYWORD);
    }
  });
});
