import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_IMPACT_BPS, filterByDepth, liquidEnough, priceImpactBps, type PoolDepth } from '../src/depth.js';

/**
 * Real reserves: every SNEK/ADA pool the collector priced at the multi-venue tick 2026-09-12 00:15
 * UTC, copied from `pool_snapshots`. Six pools across five venues — SundaeSwapV1 appears twice.
 *
 * The corpus is chosen because it reproduces the defect exactly. Differencing prices across all six
 * gives 4,914 bps, which is the figure the live query reported for this tick; the pools that survive
 * the filter agreed to 7 bps over the whole week. Note the last row: 29 ADA of TVL and a price 30%
 * below the deepest pool. That single abandoned pool IS the 4,914 bps. Keying by `poolId` rather
 * than by venue is deliberate — an earlier fixture used `DISTINCT ON (dex)`, dropped this exact row,
 * and could no longer reproduce the thing it was written to prevent.
 */
const SNEK_2026_09_12: Array<PoolDepth & { tvlAda: number }> = [
  { poolId: 'MinswapV2:f580',    reserveBase: 875_762_520n, reserveQuote: 1_864_075_438_494n, tvlAda: 3_728_151 },
  { poolId: 'WingRidersV2:6fdc', reserveBase:  71_849_759n, reserveQuote:   155_165_911_983n, tvlAda:   310_332 },
  { poolId: 'SundaeSwapV1:1f04', reserveBase:   7_576_536n, reserveQuote:    16_341_832_644n, tvlAda:    32_684 },
  { poolId: 'WingRiders:026a',   reserveBase:   1_709_396n, reserveQuote:     3_772_345_006n, tvlAda:     7_545 },
  { poolId: 'MuesliSwap:af3d',   reserveBase:     319_776n, reserveQuote:       713_066_129n, tvlAda:     1_426 },
  { poolId: 'SundaeSwapV1:1c05', reserveBase:       9_569n, reserveQuote:        14_307_489n, tvlAda:        29 },
];

/** The engine's `MIN_BUY_LOVELACE`. Not imported — @ctb/sim-executor does not depend on @ctb/engine,
 *  and this is the size a caller would choose, not a constant the two packages must share. */
const HUNDRED_ADA = 100_000_000n;

const spreadBps = (pools: readonly PoolDepth[]): number => {
  const px = pools.map((p) => Number(p.reserveQuote) / Number(p.reserveBase));
  return 10_000 * (Math.max(...px) - Math.min(...px)) / Math.min(...px);
};

describe('priceImpactBps', () => {
  it('measures the impact of a 100 ADA buy on each real SNEK pool', () => {
    const bps = Object.fromEntries(SNEK_2026_09_12.map((p) => [p.poolId, Math.round(priceImpactBps(HUNDRED_ADA, p.reserveQuote, p.reserveBase) * 10) / 10]));
    expect(bps).toEqual({
      'MinswapV2:f580': 0.7, 'WingRidersV2:6fdc': 6.5, 'SundaeSwapV1:1f04': 61.4,
      'WingRiders:026a': 265.2, 'MuesliSwap:af3d': 1_402.6, 'SundaeSwapV1:1c05': 69_896.1,
    });
  });

  /**
   * The literals above are a regression pin, and a pin blessed by the implementation that produced it
   * proves nothing. For constant product with no fee the impact is exactly `sizeIn / reserveIn`, which
   * is arrived at independently of `cpmmAmountOut`. The computed figure must sit just above it: the
   * pool hands over a whole number of tokens, and that rounding is real cost, but it is bounded.
   */
  it('CONTROL: agrees with the closed form sizeIn/reserveIn on direction and on every verdict', () => {
    for (const p of SNEK_2026_09_12) {
      const closedForm = 10_000 * Number(HUNDRED_ADA) / Number(p.reserveQuote);
      const computed = priceImpactBps(HUNDRED_ADA, p.reserveQuote, p.reserveBase);
      // Lot rounding only ever costs the taker, so the implementation may exceed the ideal and
      // never undercut it.
      expect(computed).toBeGreaterThanOrEqual(closedForm);
      // And it never moves a pool across the line. This is the assertion with teeth: a scaling bug
      // that changed any verdict fails here even though the two figures are allowed to differ.
      expect(computed <= DEFAULT_MAX_IMPACT_BPS).toBe(closedForm <= DEFAULT_MAX_IMPACT_BPS);
    }
  });

  /**
   * No single absolute tolerance spans this corpus: one unit of output rounding is 0.1 bps on
   * MinswapV2, where 100 ADA buys 46,978 SNEK, and 2.7 bps on the 29 ADA pool, where it buys 8,371.
   * Bounding it is only meaningful where the output is large, which is exactly the pools that pass.
   */
  it('lot rounding stays under a basis point on the pools the filter keeps', () => {
    for (const p of filterByDepth(SNEK_2026_09_12, HUNDRED_ADA)) {
      const closedForm = 10_000 * Number(HUNDRED_ADA) / Number(p.reserveQuote);
      expect(priceImpactBps(HUNDRED_ADA, p.reserveQuote, p.reserveBase) - closedForm).toBeLessThan(1);
    }
  });

  it('does not floor a sub-bps impact to zero', () => {
    // 100 ADA into MinswapV2's 1.86e12 lovelace is well under one bp. A first implementation scaled
    // by only 1e4 at each step, which made the numerator smaller than the divisor and floored EVERY
    // pool in this corpus to exactly 0 — reporting the dust pools as costless and passing them all.
    const deep = SNEK_2026_09_12[0]!;
    const bps = priceImpactBps(HUNDRED_ADA, deep.reserveQuote, deep.reserveBase);
    expect(bps).toBeGreaterThan(0);
    expect(bps).toBeLessThan(1);
  });

  it('is Infinity for a pool that cannot fill the trade, rather than throwing or returning 0', () => {
    expect(priceImpactBps(HUNDRED_ADA, 0n, 875_762_520n)).toBe(Infinity);
    expect(priceImpactBps(HUNDRED_ADA, 1_864_075_438_494n, 0n)).toBe(Infinity);
    expect(priceImpactBps(HUNDRED_ADA, 1n, 1n)).toBe(Infinity);
  });

  it('grows with size, because depth is relative to the trade', () => {
    const deep = SNEK_2026_09_12[0]!;
    expect(priceImpactBps(HUNDRED_ADA * 100n, deep.reserveQuote, deep.reserveBase))
      .toBeGreaterThan(priceImpactBps(HUNDRED_ADA, deep.reserveQuote, deep.reserveBase));
  });

  it('refuses a non-positive probe rather than inventing an answer', () => {
    expect(() => priceImpactBps(0n, 1_000n, 1_000n)).toThrow(/positive size/);
    expect(() => priceImpactBps(-1n, 1_000n, 1_000n)).toThrow(/positive size/);
  });
});

describe('filterByDepth on the real 2026-09-12 SNEK corpus', () => {
  it('keeps exactly the two pools that were alive', () => {
    expect(filterByDepth(SNEK_2026_09_12, HUNDRED_ADA).map((p) => p.poolId)).toEqual(['MinswapV2:f580', 'WingRidersV2:6fdc']);
  });

  /**
   * Both directions. A filter that removed everything would satisfy "excludes the dust" on its own;
   * what makes it useful is that the survivors agree inside the round-trip cost floor while the raw
   * corpus does not. 4,914 bps is the number the live query reported for this tick.
   */
  it('CONTROL: turns 4,914 bps of untradeable fiction into a spread inside the cost floor', () => {
    expect(Math.round(spreadBps(SNEK_2026_09_12))).toBe(4_914);
    expect(spreadBps(filterByDepth(SNEK_2026_09_12, HUNDRED_ADA))).toBeLessThan(216);
  });

  it('preserves input order, so a depth-sorted caller stays sorted', () => {
    const reversed = [...SNEK_2026_09_12].reverse();
    expect(filterByDepth(reversed, HUNDRED_ADA).map((p) => p.poolId)).toEqual(['WingRidersV2:6fdc', 'MinswapV2:f580']);
  });

  it('returns empty for a size no venue can absorb, which is an answer and not "no opportunity"', () => {
    expect(filterByDepth(SNEK_2026_09_12, 100_000_000_000_000n)).toEqual([]);
  });

  it('honours a caller-supplied budget', () => {
    expect(filterByDepth(SNEK_2026_09_12, HUNDRED_ADA, 100).map((p) => p.poolId))
      .toEqual(['MinswapV2:f580', 'WingRidersV2:6fdc', 'SundaeSwapV1:1f04']);
    expect(filterByDepth(SNEK_2026_09_12, HUNDRED_ADA, 1).map((p) => p.poolId)).toEqual(['MinswapV2:f580']);
  });
});

describe('liquidEnough', () => {
  it('defaults to the impact half of the measured cost floor', () => {
    expect(DEFAULT_MAX_IMPACT_BPS).toBe(34);
    const sundae = SNEK_2026_09_12[2]!;
    expect(liquidEnough(sundae, HUNDRED_ADA)).toBe(false);
    expect(liquidEnough(sundae, HUNDRED_ADA, 62)).toBe(true);
  });
});
