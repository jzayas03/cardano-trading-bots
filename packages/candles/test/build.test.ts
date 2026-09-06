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
