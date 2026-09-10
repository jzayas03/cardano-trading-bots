import { describe, expect, it } from 'vitest';
import { buyAndHold, STRATEGIES, type Candle, type StrategyContext } from '../src/index.js';

const candle = (close: string): Candle => ({ tickTs: new Date(0), open: close, high: close, low: close, close, volumeQuote: null, poolId: null, poolType: null, feeBps: null,
  closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null });
const ctxFor = (cash: bigint, pos: bigint, params: Record<string, number> = buyAndHold.defaultParams): StrategyContext => ({
  candle: candle('1'), history: [candle('1')], closes: [1], portfolio: { cashLovelace: cash, positionBase: pos }, params,
});

describe('buyAndHold', () => {
  it('buys 99% of the cash balance on the first candle it sees while flat, leaving room for the lovelace fees it cannot see', () => {
    expect(buyAndHold.defaultParams).toEqual({ fraction: 0.99 });
    expect(buyAndHold.onCandle(ctxFor(1_000_000_000n, 0n))).toEqual([{ side: 'buy', amountIn: 990_000_000n, reason: 'buy-and-hold entry' }]);
    expect(buyAndHold.onCandle(ctxFor(1_000_000_000n, 0n, { fraction: 0.25 }))).toEqual([{ side: 'buy', amountIn: 250_000_000n, reason: 'buy-and-hold entry' }]);
  });
  it('never sells and never re-buys while holding', () => {
    expect(buyAndHold.onCandle(ctxFor(1_000_000_000n, 1n))).toEqual([]);
  });
  it('tries again while still flat (a rejected first buy is retried next candle) and respects the 5 ADA floor', () => {
    expect(buyAndHold.onCandle(ctxFor(1_000_000_000n, 0n))).toHaveLength(1);
    expect(buyAndHold.onCandle(ctxFor(100_000_000n, 0n))).toEqual([]); // 99% of 100 ADA < the 100 ADA floor
  });
  it('needs one candle of warmup and fails closed on a missing fraction', () => {
    expect(buyAndHold.warmup).toBe(1);
    expect(buyAndHold.warmupFor({ fraction: 1 })).toBe(1);
    expect(() => buyAndHold.warmupFor({})).toThrow(/buy-and-hold: param fraction/);
    expect(() => buyAndHold.onCandle(ctxFor(1n, 0n, {}))).toThrow(/fraction/);
  });
  it('is registered under its id', () => {
    expect(STRATEGIES['buy-and-hold']).toBe(buyAndHold);
  });
});
