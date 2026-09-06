import type { Queryable } from '@ctb/db';
import { describe, expect, it } from 'vitest';
import { assertFakeAllowed } from '../src/fakeWalk.js';
import { cashAdaOnResumeError, fakeRowsPresent, resolveIntervalSec } from '../src/commands/paper.js';

const UNIT = 'testunit';

/** Records every statement and answers each `count(*)` from a scripted list. */
function countingDb(counts: number[]): Queryable & { sql: string[]; params: unknown[][] } {
  const sql: string[] = [];
  const params: unknown[][] = [];
  let i = 0;
  return {
    sql, params,
    query: (async (text: string, values?: unknown[]) => {
      sql.push(text);
      params.push(values ?? []);
      return { rows: [{ n: String(counts[i++] ?? 0) }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
    }) as Queryable['query'],
  };
}

/**
 * Finding I7: the isolation guard counted `pool_snapshots` only, and only within a 24-hour window.
 * Both halves were holes. `candles` is the table the paper feed actually READS — a `Fake:` candle
 * built during a rehearsal survives the snapshot it came from and would be filled against by a run
 * that believes it is trading real data. And the window meant a rehearsal left alone for a day
 * stopped being detectable at all, so "synthetic data can never be mistaken for real" quietly
 * expired on a timer. Neither table, no window.
 */
describe('fakeRowsPresent (finding I7)', () => {
  it('reports snapshot and candle counts for the token', async () => {
    const db = countingDb([2, 3]);
    expect(await fakeRowsPresent(db, UNIT)).toEqual({ snapshots: 2, candles: 3 });
    expect(db.params.every((p) => p[0] === UNIT), 'both queries are scoped to the token').toBe(true);
  });

  it('checks pool_snapshots AND candles', async () => {
    const db = countingDb([0, 0]);
    await fakeRowsPresent(db, UNIT);
    expect(db.sql.some((q) => /pool_snapshots/.test(q) && /dex = \$2/.test(q))).toBe(true);
    expect(db.sql.some((q) => /FROM candles/.test(q) && /pool_id LIKE/.test(q))).toBe(true);
  });

  it('uses no time window at all: a rehearsal left alone for a week is still detectable', async () => {
    const db = countingDb([0, 0]);
    await fakeRowsPresent(db, UNIT);
    expect(db.sql.some((q) => /interval|now\(\)/i.test(q)), 'no interval/now() clause in either query').toBe(false);
  });

  it('is parameterised, never interpolated', async () => {
    const db = countingDb([0, 0]);
    await fakeRowsPresent(db, UNIT);
    expect(db.sql.every((q) => !q.includes(UNIT))).toBe(true);
    expect(db.params.every((p) => p.length >= 2)).toBe(true);
  });
});

/**
 * Finding I7, second half: `--rehearsal` gated only on `CTB_ALLOW_FAKE_DATA=1`, so the same opt-in
 * that is safe on a laptop would have pointed a synthetic run at a remote database. The localhost
 * requirement `dev:fake-collector` has always enforced applies to the consumer too.
 */
describe('assertFakeAllowed for paper --rehearsal', () => {
  it('accepts a localhost database with the opt-in set', () => {
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, 'postgres://u:p@localhost:5433/ctb', 'paper --rehearsal')).not.toThrow();
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, 'postgres://u:p@127.0.0.1:5433/ctb', 'paper --rehearsal')).not.toThrow();
  });

  it('refuses a remote database and names the caller in the message', () => {
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, 'postgres://u:p@db.example.com:5432/ctb', 'paper --rehearsal'))
      .toThrow(/paper --rehearsal requires a localhost database, got host db\.example\.com/);
  });

  it('is not fooled by localhost as a subdomain label', () => {
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, 'postgres://u:p@localhost.evil.example:5433/ctb', 'paper --rehearsal')).toThrow();
  });

  it('still requires the opt-in', () => {
    expect(() => assertFakeAllowed({}, 'postgres://u:p@localhost:5433/ctb', 'paper --rehearsal')).toThrow(/CTB_ALLOW_FAKE_DATA=1/);
  });
});

/**
 * Finding I2: `--interval-sec` defaulted to a hard-coded 300 with no relation to the collector's own
 * `COLLECT_INTERVAL_SECONDS`. The paper feed sleeps to ITS interval's boundaries and reads candles
 * bucketed at the COLLECTOR's, so a mismatch means every boundary lands where no snapshot exists —
 * a run that heartbeats forever and yields almost nothing, with no error anywhere to explain it.
 * (Task 6's rehearsal ran both at 60 s by hand, which is exactly why nothing caught this.)
 */
describe('resolveIntervalSec', () => {
  it('defaults to the collector interval when the flag is absent', () => {
    expect(resolveIntervalSec(null, 60, false)).toBe(60);
    expect(resolveIntervalSec(null, 300, false)).toBe(300);
  });

  it('accepts an explicit value that matches the collector', () => {
    expect(resolveIntervalSec(300, 300, false)).toBe(300);
  });

  it('refuses an explicit value that differs, naming both numbers', () => {
    expect(() => resolveIntervalSec(120, 300, false))
      .toThrow('--interval-sec 120 differs from COLLECT_INTERVAL_SECONDS 300; the collector\'s boundaries would not line up');
  });

  it('allows the mismatch when the operator opts in', () => {
    expect(resolveIntervalSec(120, 300, true)).toBe(120);
  });
});

/**
 * Finding M5: `--cash-ada` was accepted alongside `--resume` and then silently ignored — the resumed
 * portfolio comes from the run's last equity row. An operator who wrote `--resume 6 --cash-ada 5000`
 * got a run continuing on the old balance with no indication their flag did nothing.
 */
describe('cashAdaOnResumeError', () => {
  it('refuses --cash-ada on a resume that has equity to restore from', () => {
    expect(cashAdaOnResumeError(true, true)).toBe('cash is restored from the run; --cash-ada is not allowed with --resume');
  });

  it('allows --cash-ada on a resume of a run that never wrote an equity row', () => {
    // Nothing to restore, so the flag is the only source of a starting balance and does have effect.
    expect(cashAdaOnResumeError(true, false)).toBeNull();
  });

  it('allows --cash-ada when not resuming', () => {
    expect(cashAdaOnResumeError(false, false)).toBeNull();
    expect(cashAdaOnResumeError(false, true)).toBeNull();
  });
});
