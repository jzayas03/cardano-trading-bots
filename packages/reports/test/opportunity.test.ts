import { describe, expect, it } from 'vitest';
import {
  bodyBps, DEFAULT_FLOOR_BPS, MIN_SAMPLES_FOR_RANGE, opportunity, quantile, rangeBps, rateOf,
  type OpportunityCandle,
} from '../src/opportunity.js';

const T0 = Date.UTC(2026, 8, 9, 0, 0, 0);
const MIN15 = 900_000;

/** A candle `i` intervals in, with an explicit high/low so each test states the move it means. */
const c = (i: number, over: Partial<OpportunityCandle> = {}): OpportunityCandle => ({
  tickTs: new Date(T0 + i * MIN15), open: 100, high: 100, low: 100, close: 100, samples: 5, ...over,
});

const OPTS = { candleIntervalSec: 900, windowSecs: [] as number[] };

describe('rangeBps and bodyBps', () => {
  it('measure the range from the low and the body from the open', () => {
    // 2.16% of 100 is 2.16, so a low of 100 and a high of 102.16 sits exactly on the floor.
    expect(rangeBps({ high: 102.16, low: 100 })).toBeCloseTo(216, 6);
    expect(bodyBps({ open: 100, close: 97.84 })).toBeCloseTo(-216, 6);
  });

  it('return 0 rather than Infinity or NaN on a degenerate candle', () => {
    // numeric(38,18) CHECKs keep these out of the table, but a caller passing a parsed '' must not
    // put Infinity into a median.
    expect(rangeBps({ high: 1, low: 0 })).toBe(0);
    expect(rangeBps({ high: Number.NaN, low: 1 })).toBe(0);
    expect(bodyBps({ open: 0, close: 1 })).toBe(0);
  });
});

describe('quantile', () => {
  it('is null for an empty series, because a quantile of nothing is not zero', () => {
    expect(quantile([], 0.5)).toBeNull();
  });

  it('interpolates and does not mutate its input', () => {
    const xs = [4, 1, 3, 2];
    expect(quantile(xs, 0.5)).toBe(2.5);
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(4);
    expect(xs).toEqual([4, 1, 3, 2]);
  });
});

describe('opportunity: the not-measured / no-opportunity distinction', () => {
  it('reports single-sample candles as NOT MEASURABLE and pctClearing null, never 0%', () => {
    // Every candle this project wrote before 2026-09-08 looks exactly like this. Reporting 0% here
    // would say "no opportunity" about data that was never capable of showing one.
    const flat = [0, 1, 2].map((i) => c(i, { samples: 1 }));

    const r = opportunity(flat, OPTS);

    expect(r.intraCandle.measurable).toBe(0);
    expect(r.intraCandle.notMeasurable).toBe(3);
    expect(r.intraCandle.pctClearing).toBeNull();
    expect(r.intraCandle.medianRangeBps).toBeNull();
    expect(r.intraCandle.p90RangeBps).toBeNull();
  });

  it('excludes them from the denominator instead of diluting it', () => {
    // One measurable candle that clears, two that were never measured. 100%, not 33%.
    const mixed = [
      c(0, { samples: 1 }),
      c(1, { samples: 5, low: 100, high: 103 }),
      c(2, { samples: 1 }),
    ];

    const r = opportunity(mixed, OPTS);

    expect(r.intraCandle.measurable).toBe(1);
    expect(r.intraCandle.clearing).toBe(1);
    expect(r.intraCandle.pctClearing).toBe(100);
  });

  it('takes MIN_SAMPLES_FOR_RANGE as the boundary', () => {
    expect(MIN_SAMPLES_FOR_RANGE).toBe(2);
    expect(opportunity([c(0, { samples: 2, high: 103 })], OPTS).intraCandle.measurable).toBe(1);
    expect(opportunity([c(0, { samples: 1, high: 103 })], OPTS).intraCandle.measurable).toBe(0);
  });
});

describe('opportunity: what a close-only strategy misses', () => {
  it('counts candles that clear the floor on range but not on the body', () => {
    const candles = [
      // ranges 300 bps, body 0 -- the move happened and round-tripped inside the candle
      c(0, { open: 100, close: 100, low: 100, high: 103 }),
      // ranges 300 bps, body 300 bps -- a close-only strategy sees this one
      c(1, { open: 100, close: 103, low: 100, high: 103 }),
      // ranges 100 bps -- clears nothing
      c(2, { open: 100, close: 101, low: 100, high: 101 }),
    ];

    const r = opportunity(candles, OPTS);

    expect(r.intraCandle.clearing).toBe(2);
    expect(r.intraCandle.missedByCloseOnly).toBe(1);
  });

  it('counts a DOWN body as seen, not missed', () => {
    // The comparison is on absolute size: a strategy can profit from a fall. Using the signed body
    // would have called this one missed.
    const r = opportunity([c(0, { open: 103, close: 100, low: 100, high: 103 })], OPTS);
    expect(r.intraCandle.clearing).toBe(1);
    expect(r.intraCandle.missedByCloseOnly).toBe(0);
  });
});

describe('opportunity: windows', () => {
  const rising = (n: number, stepBps: number): OpportunityCandle[] =>
    Array.from({ length: n }, (_, i) => {
      const price = 100 * (1 + (stepBps / 10_000)) ** i;
      return c(i, { open: price, close: price, low: price, high: price, samples: 5 });
    });

  it('measures a fixed DURATION, not a fixed number of bars', () => {
    // 8 candles of 900 s is exactly 2 h. 100 bps per candle compounds past 216 over three of them.
    const r = opportunity(rising(20, 100), { candleIntervalSec: 900, windowSecs: [1800, 7200] });
    const half = r.windows.find((w) => w.seconds === 1800)!;
    const twoH = r.windows.find((w) => w.seconds === 7200)!;
    expect(half.windows).toBe(18);   // 20 candles, 2 steps each
    expect(twoH.windows).toBe(12);   // 20 candles, 8 steps each
    expect(half.pctClearing).toBe(0);      // 2 x 100 bps = 201 < 216
    expect(twoH.pctClearing).toBe(100);    // 8 x 100 bps = 829 > 216
  });

  it('refuses a window that is not a whole number of candles', () => {
    // 1000 s is 1.11 candles; silently rounding it would report a duration nobody asked for.
    expect(() => opportunity(rising(4, 10), { candleIntervalSec: 900, windowSecs: [1000] }))
      .toThrow(/not a whole number of 900s candles/);
  });

  it('skips windows containing a gap and counts them, rather than measuring across an outage', () => {
    // A collector outage between candle 1 and 4. Any window spanning it describes our downtime.
    const candles = [c(0), c(1), c(4), c(5), c(6)];
    const r = opportunity(candles, { candleIntervalSec: 900, windowSecs: [1800] });
    const w = r.windows[0]!;
    // 0->2 and 1->3 both land in the hole; 4->6 is the only intact window; 5->7 and 6->8 run off
    // the end and are not gaps.
    expect(w.windows).toBe(1);
    expect(w.skippedForGaps).toBe(2);
  });

  it('does not count windows that merely run off the end of the series as gaps', () => {
    const r = opportunity([c(0), c(1), c(2)], { candleIntervalSec: 900, windowSecs: [1800] });
    expect(r.windows[0]!.windows).toBe(1);
    expect(r.windows[0]!.skippedForGaps).toBe(0);
  });

  it('is null, not 0, when no window could be formed at all', () => {
    const r = opportunity([c(0)], { candleIntervalSec: 900, windowSecs: [7200] });
    expect(r.windows[0]!.windows).toBe(0);
    expect(r.windows[0]!.pctClearing).toBeNull();
    expect(r.windows[0]!.medianAbsBps).toBeNull();
  });

  it('CONTROL: a flat series clears nothing, which is what a stablecoin must look like', () => {
    // The USDA control from docs/ops/2026-09-08-token-choice.md, in miniature. A method that reports
    // opportunity on a series with none is measuring its own arithmetic.
    const r = opportunity(rising(20, 0), { candleIntervalSec: 900, windowSecs: [1800, 7200] });
    expect(r.windows.every((w) => w.pctClearing === 0)).toBe(true);
    expect(r.intraCandle.clearing).toBe(0);
  });
});

describe('opportunity: input contract', () => {
  it('refuses unsorted or duplicated candles instead of producing nonsense', () => {
    expect(() => opportunity([c(1), c(0)], OPTS)).toThrow(/sorted ascending/);
    expect(() => opportunity([c(0), c(0)], OPTS)).toThrow(/sorted ascending/);
  });

  it('refuses an invalid tickTs, which would otherwise FABRICATE windows', () => {
    // Not hypothetical: found running this against live data. Postgres renders a timestamptz as
    // `2026-09-08 19:30:00+00`, which Date parses fine -- but turning it into ISO with a naive
    // `.replace(' ', 'T')` gives `2026-09-08T19:30:00+00`, and a two-digit offset is NOT valid ISO,
    // so THAT parses to Invalid Date. (`+00:00` is fine. The space form is fine. Only the pair is
    // fatal, which is why it survives casual testing.)
    //
    // getTime() is then NaN, the sortedness check below cannot see it because every comparison
    // against NaN is false, and Map key equality is SameValueZero -- so every candle collapses onto
    // the single key NaN, `has(NaN)` answers true for every contiguity probe, and two candles
    // reported two complete two-hour windows. Silently wrong, in the direction of claiming MORE data
    // than exists.
    expect(new Date('2026-09-08 19:30:00+00').getTime()).not.toBeNaN();
    expect(new Date('2026-09-08T19:30:00+00').getTime()).toBeNaN();
    const bad = [c(0), { ...c(1), tickTs: new Date('2026-09-08T19:30:00+00') }];
    expect(() => opportunity(bad, { candleIntervalSec: 900, windowSecs: [7200] })).toThrow(/invalid tickTs/);
  });

  it('CONTROL: two candles cannot form a two-hour window', () => {
    // The assertion the NaN bug was violating. Eight 900 s steps need nine candles.
    const r = opportunity([c(0), c(1)], { candleIntervalSec: 900, windowSecs: [7200] });
    expect(r.windows[0]!.windows).toBe(0);
    expect(r.windows[0]!.pctClearing).toBeNull();
  });

  it('refuses a non-positive candle interval', () => {
    expect(() => opportunity([c(0)], { candleIntervalSec: 0, windowSecs: [] })).toThrow(/must be positive/);
  });

  it('defaults the floor to the measured 2.16% round trip', () => {
    expect(DEFAULT_FLOOR_BPS).toBe(216);
    expect(opportunity([c(0)], OPTS).floorBps).toBe(216);
    expect(opportunity([c(0)], { ...OPTS, floorBps: 500 }).floorBps).toBe(500);
  });
});

describe('a rate is never reportable without its sample size', () => {
  // The defect this closes, and I shipped it: "11.9% of 2-hour windows clear the floor" was quoted
  // in a review document as a finding. Run against the real corpus it is 7.1% OF FOURTEEN WINDOWS --
  // one window -- whose 95% interval runs from about 1% to 32%. The point estimate was not wrong; it
  // was unsupported, and nothing in the output said so, so it travelled.
  it('carries a Wilson 95% interval and flags a rate too wide to support a claim', () => {
    const r = rateOf(1, 14);
    expect(r.pct).toBeCloseTo(7.14, 2);
    expect(r.ciLowPct).toBeCloseTo(1.3, 1);
    expect(r.ciHighPct).toBeCloseTo(31.5, 1);
    expect(r.underpowered).toBe(true);
  });

  it('does not cry wolf on a sample that can actually support the claim', () => {
    const r = rateOf(100, 1000);
    expect(r.pct).toBeCloseTo(10, 6);
    expect(r.ciLowPct).toBeCloseTo(8.3, 1);
    expect(r.ciHighPct).toBeCloseTo(12.0, 1);
    expect(r.underpowered).toBe(false);
  });

  it('is null, never 0, at zero trials — and still refuses to be quoted', () => {
    const r = rateOf(0, 0);
    expect(r.pct).toBeNull();
    expect(r.ciLowPct).toBeNull();
    expect(r.ciHighPct).toBeNull();
    expect(r.underpowered).toBe(true);
  });

  it('brackets the point estimate at both extremes without escaping [0, 100]', () => {
    const none = rateOf(0, 10);
    expect(none.pct).toBe(0);
    expect(none.ciLowPct).toBe(0);
    expect(none.ciHighPct).toBeGreaterThan(0);
    const all = rateOf(10, 10);
    expect(all.pct).toBe(100);
    expect(all.ciHighPct).toBe(100);
    expect(all.ciLowPct).toBeLessThan(100);
  });

  it('threads the interval onto the window and intra-candle stats the report returns', () => {
    const candles = Array.from({ length: 6 }, (_, i) => ({
      tickTs: new Date(Date.UTC(2026, 8, 6, i)),
      open: 1, high: 1, low: 1, close: 1 + i * 0.01, samples: 4,
    }));
    const r = opportunity(candles, { floorBps: 216, candleIntervalSec: 3600, windowSecs: [7200] });
    const w = r.windows[0]!;
    expect(w.underpowered).toBe(true); // a handful of windows can never carry a rate
    expect(w.ciLowPct).not.toBeNull();
    expect(w.ciHighPct).not.toBeNull();
    expect(r.intraCandle.underpowered).toBe(true);
  });
});
