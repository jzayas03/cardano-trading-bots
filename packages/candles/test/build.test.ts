import { describe, expect, it } from 'vitest';
import { buildCandles, type SnapshotForCandle } from '../src/index.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const t = (m: number) => new Date(Date.UTC(2026, 8, 6, 12, m, 0));
const snap = (o: Partial<SnapshotForCandle> & { tickTs: Date; poolId: string }): SnapshotForCandle => ({
  reserveBase: 23_779_491n, reserveQuote: 52_331_970_594n, feeBps: 100, poolType: 'cpmm', tvlLovelace: 104_663_941_188n, ...o,
});

describe('buildCandles', () => {
  it('picks the deepest pool per tick and emits ascending candles with degenerate OHLC', () => {
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(5), poolId: 'MinswapV2:a', tvlLovelace: 500n, reserveBase: 100n, reserveQuote: 200n }),
      snap({ tickTs: t(0), poolId: 'SundaeSwapV3:b' }),
      snap({ tickTs: t(5), poolId: 'SundaeSwapV3:b', tvlLovelace: 104_663_941_188n }),
    ]);
    expect(rows.map((r) => r.tickTs)).toEqual([t(0), t(5)]);
    expect(rows[1]?.poolId).toBe('SundaeSwapV3:b');
    const c = rows[0]!;
    expect([c.open, c.high, c.low]).toEqual([c.close, c.close, c.close]);
    expect(c.close.startsWith('0.0022007187')).toBe(true);
    expect(c.closeReserveBase).toBe(23_779_491n);
  });

  it('net flow is the reserve delta against the previous candle of the same pool', () => {
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(0), poolId: 'p', reserveBase: 1_000n, reserveQuote: 2_000n }),
      snap({ tickTs: t(5), poolId: 'p', reserveBase: 900n, reserveQuote: 2_250n }),
    ]);
    expect(rows[0]?.netFlowBase).toBeNull();
    expect(rows[1]?.netFlowBase).toBe(-100n);
    expect(rows[1]?.netFlowQuote).toBe(250n);
  });

  it('a window where flows net to zero shows zero net flow (this is not volume)', () => {
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(0), poolId: 'p', reserveBase: 1_000n, reserveQuote: 2_000n }),
      snap({ tickTs: t(5), poolId: 'p', reserveBase: 1_000n, reserveQuote: 2_000n }),
    ]);
    expect(rows[1]?.netFlowBase).toBe(0n);
    expect(rows[1]?.netFlowQuote).toBe(0n);
    expect(Object.keys(rows[1]!)).not.toContain('volume');
  });

  it('nulls the flow when the deepest pool changes', () => {
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(0), poolId: 'p', tvlLovelace: 10n }),
      snap({ tickTs: t(5), poolId: 'q', tvlLovelace: 20n }),
    ]);
    expect(rows[1]?.poolId).toBe('q');
    expect(rows[1]?.netFlowBase).toBeNull();
  });

  it('seeds the first delta from `previous` for incremental builds', () => {
    const rows = buildCandles(SNEK, 0, [snap({ tickTs: t(5), poolId: 'p', reserveBase: 90n, reserveQuote: 210n })], {
      tickTs: t(0), poolId: 'p', closeReserveBase: 100n, closeReserveQuote: 200n,
    });
    expect(rows[0]?.netFlowBase).toBe(-10n);
    expect(rows[0]?.netFlowQuote).toBe(10n);
  });

  it('breaks ties deterministically on poolId', () => {
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(0), poolId: 'Zed:1', tvlLovelace: 5n }),
      snap({ tickTs: t(0), poolId: 'Alpha:1', tvlLovelace: 5n }),
    ]);
    expect(rows[0]?.poolId).toBe('Alpha:1');
  });

  it('fails closed on bad input', () => {
    expect(() => buildCandles(SNEK, 0, [snap({ tickTs: t(0), poolId: 'p', poolType: 'stable' as 'cpmm' })])).toThrow(/pool_type/);
    expect(() => buildCandles(SNEK, 0, [snap({ tickTs: t(0), poolId: 'p', reserveBase: 0n })])).toThrow(/reserve/);
    expect(() => buildCandles(SNEK, 0, [snap({ tickTs: t(0), poolId: 'p' })], { tickTs: t(5), poolId: 'p', closeReserveBase: 1n, closeReserveQuote: 1n })).toThrow(/earlier/);
  });
});

/**
 * Bucketing several snapshots into one candle — the only way this project gets a real high and low.
 * Before it, every candle we produced had open = high = low = close: 2,306 of 2,306 on 2026-09-08,
 * against 0.2% in trade-derived data.
 */
describe('buildCandles with a candle interval', () => {
  const CANDLE_SEC = 900;
  // Price = quote/base. Rising base at fixed quote means a FALLING price, so these are deliberately
  // out of order: 100 -> 90 (up) -> 110 (down) -> 95, within one 15-minute bucket.
  const inOneBucket = [
    snap({ tickTs: t(0), poolId: 'p', reserveBase: 100n, reserveQuote: 1_000n, tvlLovelace: 1_000n }),
    snap({ tickTs: t(1), poolId: 'p', reserveBase: 90n,  reserveQuote: 1_000n, tvlLovelace: 1_000n }),
    snap({ tickTs: t(2), poolId: 'p', reserveBase: 110n, reserveQuote: 1_000n, tvlLovelace: 1_000n }),
    snap({ tickTs: t(3), poolId: 'p', reserveBase: 95n,  reserveQuote: 1_000n, tvlLovelace: 1_000n }),
  ];

  it('emits ONE candle for the bucket, with a real range', () => {
    const rows = buildCandles(SNEK, 0, inOneBucket, undefined, CANDLE_SEC);
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect(Number(c.high)).toBeGreaterThan(Number(c.low));   // the whole point
    // price = (quote/1e6)/(base/10^decimals); decimals=0 here, so quote/(base*1e6).
    expect(Number(c.high)).toBeCloseTo(1000 / (90 * 1e6), 12);   // highest price = smallest base
    expect(Number(c.low)).toBeCloseTo(1000 / (110 * 1e6), 12);
  });

  it('opens on the FIRST sample and closes on the LAST, not on the deepest', () => {
    const rows = buildCandles(SNEK, 0, inOneBucket, undefined, CANDLE_SEC);
    expect(Number(rows[0]!.open)).toBeCloseTo(1000 / (100 * 1e6), 12);
    expect(Number(rows[0]!.close)).toBeCloseTo(1000 / (95 * 1e6), 12);
    expect(rows[0]!.closeReserveBase).toBe(95n);             // reserves come from the close too
  });

  it('stamps the candle at the bucket boundary, so candles land on a regular grid', () => {
    const rows = buildCandles(SNEK, 0, inOneBucket, undefined, CANDLE_SEC);
    expect(rows[0]!.tickTs.getTime() % (CANDLE_SEC * 1000)).toBe(0);
  });

  it('takes prices ONLY from the deepest pool, never mixing two markets into one range', () => {
    const rows = buildCandles(SNEK, 0, [
      ...inOneBucket,
      // A shallower pool quoting a wildly different price in the same bucket. If its price leaked
      // into the high, the candle would describe a market we never traded.
      snap({ tickTs: t(2), poolId: 'shallow', reserveBase: 1n, reserveQuote: 1_000_000n, tvlLovelace: 1n }),
    ], undefined, CANDLE_SEC);
    expect(rows[0]!.poolId).toBe('p');
    expect(Number(rows[0]!.high)).toBeCloseTo(1000 / (90 * 1e6), 12);
  });

  it('splits across buckets and keeps them ascending', () => {
    const rows = buildCandles(SNEK, 0, [...inOneBucket,
      snap({ tickTs: t(16), poolId: 'p', reserveBase: 80n, reserveQuote: 1_000n, tvlLovelace: 1_000n }),
    ], undefined, CANDLE_SEC);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.tickTs.getTime()).toBeGreaterThan(rows[0]!.tickTs.getTime());
  });

  it('a single sample in a bucket still yields o=h=l=c, exactly as before bucketing existed', () => {
    const one = [snap({ tickTs: t(3), poolId: 'p', reserveBase: 100n, reserveQuote: 1_000n })];
    const c = buildCandles(SNEK, 0, one, undefined, CANDLE_SEC)[0]!;
    expect([c.open, c.high, c.low]).toEqual([c.close, c.close, c.close]);
  });

  it('compares prices numerically, not as the decimal STRINGS they are formatted to', () => {
    // priceAdaPerToken returns an 18-place decimal string, where '9…' sorts after '10…'. Selecting
    // extremes lexically would pick the wrong high whenever the digit count changes.
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(0), poolId: 'p', reserveBase: 1n, reserveQuote: 9n, tvlLovelace: 9n }),   // price 9
      snap({ tickTs: t(1), poolId: 'p', reserveBase: 1n, reserveQuote: 10n, tvlLovelace: 9n }),  // price 10
    ], undefined, CANDLE_SEC);
    // Asserted as a RATIO so the assertion cannot be wrong about magnitude the way my first
    // attempt was: whatever the scale, the high must be 10/9 of the low.
    expect(Number(rows[0]!.high) / Number(rows[0]!.low)).toBeCloseTo(10 / 9, 9);
  });
});
