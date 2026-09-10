import { describe, expect, it } from 'vitest';
import { BLOCKFROST_FREE_DAILY_QUOTA } from '../src/digest.js';
import {
  checkDigestLines,
  checkQuotaSpend, checkRecurringTickErrors, checkTickProductivity, verdict,
  QUOTA_SPEND_WARN_AT, RECURRING_ERROR_TICKS_FAIL, UNPRODUCTIVE_TICKS_FAIL,
  type TickHealthRow,
} from '../src/doctor.js';

/**
 * 2026-09-08: `ctb-watch` ran fifteen times and exited 0 every time, while the collector finished a
 * tick punctually every fifteen minutes writing `pools 0/0, calls 0` — the Blockfrost quota was
 * exhausted and every tick failed closed at `/blocks/latest` with a 402. Three paper runs sat on the
 * dead feed for four hours.
 *
 * Nothing was STALE, so the collector check passed. The quota check projects a RATE, and a tick that
 * spends nothing lowers the rate, so it reported a healthier number the longer the outage lasted.
 * Nothing read the errors on the run rows at all.
 *
 * These are the rows that actually existed. The suite's job is to fail on them.
 */
const dead402 = (n: number): TickHealthRow[] =>
  Array.from({ length: n }, () => ({
    finishedAt: new Date('2026-09-08T21:00:10Z'),
    poolsWritten: 0,
    errors: [{ scope: 'tip', message: 'blockfrost /blocks/latest returned 402' }],
  }));

const healthy = (n: number, pools = 20): TickHealthRow[] =>
  Array.from({ length: n }, () => ({ finishedAt: new Date('2026-09-08T19:00:10Z'), poolsWritten: pools, errors: [] }));

describe('the day the watchdog stayed silent', () => {
  it('FAILS on the real rows, where it previously exited 0', () => {
    const rows = dead402(3);

    const checks = [checkTickProductivity(rows), checkRecurringTickErrors(rows), checkQuotaSpend(43_469, 45_000)];

    expect(checks.map((c) => c.status)).toEqual(['fail', 'fail', 'warn']);
    // The exit code is the whole contract of the unit: "non-zero exit is the alarm".
    expect(verdict(checks).exitCode).toBe(1);
    expect(checks[1]!.detail).toContain('402');
  });

  it('CONTROL: stays silent on healthy rows, or it is just an alarm that always rings', () => {
    const rows = healthy(5);

    const checks = [checkTickProductivity(rows), checkRecurringTickErrors(rows), checkQuotaSpend(12_000, 45_000)];

    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(verdict(checks).exitCode).toBe(0);
  });
});

describe('why the OLD check set could not see it', () => {
  // These are the digest lines today's data actually produced. Kept as a regression pin: if the new
  // checks are ever removed, this test still shows that what remains does NOT cover this failure.
  const todaysDigest = [
    // Not stale. The collector finished a tick two minutes ago -- it was punctual throughout.
    'collector: last tick 2026-09-08T21:00:00Z finished 2m ago | 0 pools',
    // The pace projection. Every tick spent 0 once the quota was gone, so the projected day FELL as
    // the outage went on: this line reads healthier the worse things get.
    'calls since 00:00 UTC: 43469 (25174 discovery + 18295 refresh over 21h) -> projected 43600/day of 50000 (87%) | quota: WATCH',
  ];

  it('the old checks alone exit 0 on the rows from the outage', () => {
    const old = checkDigestLines(todaysDigest);
    // A WATCH is a warning, and `verdict` returns 0 for any number of warnings -- so a unit whose
    // whole contract is the exit code hears nothing.
    expect(old.some((c) => c.status === 'fail')).toBe(false);
    expect(verdict(old).exitCode).toBe(0);
  });

  it('adding the new checks to the SAME digest turns it into an alarm', () => {
    const rows = dead402(3);
    const all = [
      ...checkDigestLines(todaysDigest),
      checkTickProductivity(rows), checkRecurringTickErrors(rows), checkQuotaSpend(43_469, 45_000),
    ];
    expect(verdict(all).exitCode).toBe(1);
    expect(all.filter((c) => c.status === 'fail').map((c) => c.name)).toEqual(['tick productivity', 'tick errors']);
  });
});

describe('checkTickProductivity', () => {
  it('fails only once the barren run reaches the threshold', () => {
    expect(checkTickProductivity(dead402(UNPRODUCTIVE_TICKS_FAIL)).status).toBe('fail');
    expect(checkTickProductivity([...dead402(UNPRODUCTIVE_TICKS_FAIL - 1), ...healthy(3)]).status).toBe('warn');
  });

  it('counts only the LEADING run, so an old outage does not alarm forever', () => {
    // Recovered: newest ticks are producing again. The historic zeros are not a current fault.
    expect(checkTickProductivity([...healthy(3), ...dead402(10)]).status).toBe('ok');
  });

  it('ignores unfinished ticks, which have written nothing YET', () => {
    // A tick in flight has poolsWritten 0 on its row. Counting it would alarm every time a tick is
    // simply running, which is most of the time under a 180 s loop.
    const inFlight: TickHealthRow = { finishedAt: null, poolsWritten: 0, errors: [] };
    expect(checkTickProductivity([inFlight, ...healthy(3)]).status).toBe('ok');
  });

  it('warns rather than claiming health when there is nothing finished to judge', () => {
    expect(checkTickProductivity([]).status).toBe('warn');
    expect(checkTickProductivity([{ finishedAt: null, poolsWritten: 0, errors: [] }]).status).toBe('warn');
  });

  it('treats a partial tiered tick as productive', () => {
    // Under tiered sampling a focus-only tick refreshes ONE pool. Writing 1 is working as designed;
    // a threshold of "fewer than all pools" would alarm on 4 ticks out of every 5.
    expect(checkTickProductivity(healthy(3, 1)).status).toBe('ok');
  });
});

describe('checkRecurringTickErrors', () => {
  it('names the scope that repeats on every recent tick', () => {
    const c = checkRecurringTickErrors(dead402(RECURRING_ERROR_TICKS_FAIL));
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('tip');
    expect(c.detail).toContain('blockfrost /blocks/latest returned 402');
  });

  it('ignores an INTERMITTENT error, or the operator learns to ignore the check', () => {
    // Two of three is a blip. Only a scope present in every one of the last N is a condition.
    const rows = [...dead402(2), ...healthy(1)];
    expect(checkRecurringTickErrors(rows).status).toBe('ok');
  });

  it('reports the intersection when several scopes persist, not just the first seen', () => {
    const rows: TickHealthRow[] = Array.from({ length: 3 }, () => ({
      finishedAt: new Date(), poolsWritten: 0,
      errors: [{ scope: 'discover:MinswapV2', message: 'no pools' }, { scope: 'budget', message: 'refused' }],
    }));
    expect(checkRecurringTickErrors(rows).detail).toContain('budget, discover:MinswapV2');
  });

  it('says so rather than failing when there are too few ticks to compare', () => {
    expect(checkRecurringTickErrors(dead402(1)).status).toBe('ok');
    expect(checkRecurringTickErrors(dead402(1)).detail).toContain('fewer than');
  });
});

describe('checkQuotaSpend', () => {
  it('measures what is SPENT, which is what a rate projection cannot answer', () => {
    // The precise divergence: once the quota is gone every tick spends 0 and the PACE projection
    // improves. Actual spend only ever rises.
    // FAIL is still the CEILING: at or over our own brake, the next discovery sweep is refused.
    expect(checkQuotaSpend(45_000, 45_000).status).toBe('fail');
    expect(checkQuotaSpend(44_999, 45_000).status).toBe('warn');
    // WARN is now the vendor's TIER, not the ceiling. 2026-09-09: warning at 80% of a self-imposed
    // 45,000 brake fired on a NORMAL ~39,240-call day (87% of the ceiling, but only 78% of the
    // 50,000 tier), so it warned daily — and a check that fires every day is one nobody reads.
    expect(checkQuotaSpend(39_240, 45_000).status).toBe('ok');
    expect(checkQuotaSpend(Math.ceil(BLOCKFROST_FREE_DAILY_QUOTA * QUOTA_SPEND_WARN_AT), 45_000).status).toBe('warn');
    expect(checkQuotaSpend(Math.floor(BLOCKFROST_FREE_DAILY_QUOTA * QUOTA_SPEND_WARN_AT) - 1, 45_000).status).toBe('ok');
    // Both denominators are always printed, because they answer different questions.
    expect(checkQuotaSpend(39_240, 45_000).detail).toMatch(/87% of the 45000 ceiling, 78% of the 50000 tier/);
  });

  it('says a sweep will be refused, because that is the consequence the operator acts on', () => {
    expect(checkQuotaSpend(46_000, 45_000).detail).toContain('refused');
  });

  it('does not divide by a ceiling of zero when the operator disabled it', () => {
    const c = checkQuotaSpend(60_000, 0);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('no ceiling configured');
    expect(c.detail).not.toContain('NaN');
    expect(c.detail).not.toContain('Infinity');
  });
});
