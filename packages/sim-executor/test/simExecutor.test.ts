import { describe, expect, it } from 'vitest';
import type { Candle } from '@ctb/engine';
import { costsForPoolId, DEFAULT_COSTS, SimExecutor } from '../src/index.js';

const RQ = 52_331_970_594n;
const RB = 23_779_491n;
const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const MID = '0.002200718703104284'; // priceAdaPerToken(RQ, RB, 0)
const at: Candle = { tickTs: new Date(Date.UTC(2026, 8, 6, 0, 0)), open: MID, high: MID, low: MID, close: MID, volumeQuote: null, poolId: 'SundaeSwapV3:x', poolType: 'cpmm', feeBps: 100,
  closeReserveBase: RB, closeReserveQuote: RQ, tvlLovelace: 2n * RQ };
// next's reserves are deliberately different from at's, so a fill computed from `at` instead of `next`
// (spec §7: fills use t+1, never t) produces different numbers and a mixed-up implementation is caught.
const next: Candle = { ...at, tickTs: new Date(Date.UTC(2026, 8, 6, 0, 5)), closeReserveQuote: RQ + 1_000_000_000n };
const rich = { cashLovelace: 10_000_000_000n, positionBase: 10_000_000n };

describe('SimExecutor cpmm_observed', () => {
  const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' } });

  it('fills a buy at t+1 reserves with pool, batcher, and network fees and 289 bps slippage', () => {
    const r = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, next, rich);
    expect(r).toMatchObject({ status: 'filled', poolId: 'SundaeSwapV3:x', unitIn: 'lovelace', amountIn: 1_000_000_000n, amountOut: 433_373n,
      unitOut: SNEK, poolFeeIn: 10_000_000n, batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n, slippageBps: 289, midPrice: MID, tsFill: next.tickTs });
    expect((r as { fillPrice: string }).fillPrice.startsWith('0.0023074810')).toBe(true);
  });

  it('fills a sell with 496 bps slippage', () => {
    const r = ex.fill({ side: 'sell', amountIn: 1_000_000n, reason: 't' }, at, next, rich);
    expect(r).toMatchObject({ status: 'filled', unitIn: SNEK, unitOut: 'lovelace', amountOut: 2_131_600_156n, slippageBps: 496 });
  });

  it('rejects when t+1 has no reserves, or is not cpmm, or has no pool', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, { ...next, closeReserveBase: null }, rich)).toEqual({ status: 'rejected', reason: 'no reserves at t+1' });
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, { ...next, poolType: 'stable' as 'cpmm' }, rich)).toEqual({ status: 'rejected', reason: 'pool_type stable not cpmm' });
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, { ...next, poolId: null }, rich)).toEqual({ status: 'rejected', reason: 'no pool at t+1' });
  });

  it('rejects insufficient cash (fees included), insufficient position, and dust', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, next, { cashLovelace: 1_001_000_000n, positionBase: 0n })).toEqual({ status: 'rejected', reason: 'insufficient cash' });
    expect(ex.fill({ side: 'sell', amountIn: 5n, reason: 't' }, at, next, { cashLovelace: 0n, positionBase: 4n })).toEqual({ status: 'rejected', reason: 'insufficient position' });
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, next, rich)).toEqual({ status: 'rejected', reason: 'dust' });
  });
});

describe('SimExecutor cpmm_synthetic_depth', () => {
  it('builds reserves from price and declared depth and fills with the same math', () => {
    const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: RQ } });
    const ext: Candle = { ...next, poolId: null, poolType: null, feeBps: null, closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null, volumeQuote: '10' };
    const r = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, { ...at, poolId: null }, ext, rich);
    // synthetic reserveBase = RQ / price = 23 779 491 (rounding may differ by 1); fee default 30 bps
    expect(r.status).toBe('filled');
    const f = r as Extract<typeof r, { status: 'filled' }>;
    expect(f.poolId).toBe('synthetic');
    expect(f.poolFeeIn).toBe(3_000_000n);
    expect(f.amountOut).toBeGreaterThan(441_500n); // lower fee than the observed pool
    expect(f.amountOut).toBeLessThan(RB);
  });
});

describe('costsForPoolId', () => {
  it('returns the venue table and applies overrides', () => {
    expect(costsForPoolId('MinswapV2:abc')).toEqual(DEFAULT_COSTS);
    expect(costsForPoolId('Splash:abc', { batcherFeeLovelace: 1_500_000n })).toEqual({ batcherFeeLovelace: 1_500_000n, networkFeeLovelace: 200_000n });
    expect(() => costsForPoolId('FutureSwap:abc')).toThrow(/unknown venue/);
  });
});
