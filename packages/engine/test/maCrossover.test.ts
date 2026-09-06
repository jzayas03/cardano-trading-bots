import { describe, expect, it } from 'vitest';
import { maCrossover, type Candle, type StrategyContext } from '../src/index.js';

const candle = (close: string): Candle => ({ tickTs: new Date(0), open: close, high: close, low: close, close, volumeQuote: null, poolId: null, poolType: null, feeBps: null,
  closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null });
const ctxFor = (closes: number[], cash: bigint, pos: bigint): StrategyContext => ({
  candle: candle(String(closes.at(-1))), history: closes.map((x) => candle(String(x))), closes, portfolio: { cashLovelace: cash, positionBase: pos }, params: { fast: 2, slow: 3, fraction: 0.5 },
});

describe('maCrossover', () => {
  it('buys half the cash on an up-cross', () => {
    // fast(2)/slow(3): prev closes [3,2,1,2] -> fast 1.5 slow 1.67 (below); now [3,2,1,2,4] -> fast 3 slow 2.33 (above)
    const out = maCrossover.onCandle(ctxFor([3, 2, 1, 2, 4], 100_000_000n, 0n));
    expect(out).toEqual([{ side: 'buy', amountIn: 50_000_000n, reason: 'ma up-cross fast=2 slow=3' }]);
  });
  it('sells the whole position on a down-cross', () => {
    const out = maCrossover.onCandle(ctxFor([1, 2, 3, 2, 0.5], 0n, 777n));
    expect(out).toEqual([{ side: 'sell', amountIn: 777n, reason: 'ma down-cross fast=2 slow=3' }]);
  });
  it('does nothing without a cross, below the 5 ADA floor, or with nothing to sell', () => {
    expect(maCrossover.onCandle(ctxFor([1, 2, 3, 4, 5], 100_000_000n, 0n))).toEqual([]);
    expect(maCrossover.onCandle(ctxFor([3, 2, 1, 2, 4], 8_000_000n, 0n))).toEqual([]); // half of 8 ADA < 5 ADA
    expect(maCrossover.onCandle(ctxFor([1, 2, 3, 2, 0.5], 0n, 0n))).toEqual([]);
  });
  it('declares warmup = slow + 1 from defaults', () => {
    expect(maCrossover.warmup).toBe(49);
    expect(maCrossover.defaultParams).toEqual({ fast: 12, slow: 48, fraction: 0.5 });
  });
});
