import { describe, expect, it } from 'vitest';
import { rsi, rsiMeanReversion, STRATEGIES, type Candle, type StrategyContext } from '../src/index.js';

const candle = (close: string): Candle => ({ tickTs: new Date(0), open: close, high: close, low: close, close, volumeQuote: null, poolId: null, poolType: null, feeBps: null,
  closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null });
const P = { period: 2, buyBelow: 30, sellAbove: 70, fraction: 0.5 };
const ctxFor = (closes: number[], cash: bigint, pos: bigint, params: Record<string, number> = P): StrategyContext => ({
  candle: candle(String(closes.at(-1))), history: closes.map((x) => candle(String(x))), closes, portfolio: { cashLovelace: cash, positionBase: pos }, params,
});

describe('rsiMeanReversion', () => {
  // Fixtures derived from rsi() itself so the expectations are about the cross, not about
  // remembered RSI values: three falling closes give RSI 0, one rising close after them gives 50.
  it('fixture check: the falling run is oversold and the bounce crosses back above 30', () => {
    expect(rsi([10, 9, 8, 7], 2)).toBe(0);
    expect(rsi([10, 9, 8, 7, 8], 2)).toBe(50);
    expect(rsi([1, 2, 3, 4], 2)).toBe(100);
    expect(rsi([1, 2, 3, 4, 3], 2)).toBe(50);
  });
  it('buys half the cash when RSI crosses back up through buyBelow while flat', () => {
    expect(rsiMeanReversion.onCandle(ctxFor([10, 9, 8, 7, 8], 1_000_000_000n, 0n))).toEqual([
      { side: 'buy', amountIn: 500_000_000n, reason: 'rsi back above 30 (0.0 -> 50.0) period=2' },
    ]);
  });
  it('does not buy while still below buyBelow, nor while holding, nor under the 5 ADA floor', () => {
    expect(rsiMeanReversion.onCandle(ctxFor([10, 9, 8, 7], 100_000_000n, 0n))).toEqual([]); // 0 -> 0: no cross
    expect(rsiMeanReversion.onCandle(ctxFor([10, 9, 8, 7, 8], 100_000_000n, 5n))).toEqual([]); // holding
    expect(rsiMeanReversion.onCandle(ctxFor([10, 9, 8, 7, 8], 8_000_000n, 0n))).toEqual([]); // 4 ADA < 5 ADA
  });
  it('sells the whole position when RSI crosses back down through sellAbove', () => {
    expect(rsiMeanReversion.onCandle(ctxFor([1, 2, 3, 4, 3], 0n, 777n))).toEqual([
      { side: 'sell', amountIn: 777n, reason: 'rsi back below 70 (100.0 -> 50.0) period=2' },
    ]);
    expect(rsiMeanReversion.onCandle(ctxFor([1, 2, 3, 4, 3], 0n, 0n))).toEqual([]); // nothing to sell
    expect(rsiMeanReversion.onCandle(ctxFor([1, 2, 3, 4], 0n, 777n))).toEqual([]); // 100 -> 100: no cross
  });
  it('emits nothing before rsi has enough closes', () => {
    expect(rsiMeanReversion.onCandle(ctxFor([10, 9], 100_000_000n, 0n))).toEqual([]);
  });
  it('derives warmup = period + 2 from the params in force', () => {
    expect(rsiMeanReversion.warmup).toBe(16);
    expect(rsiMeanReversion.warmupFor(rsiMeanReversion.defaultParams)).toBe(16);
    expect(rsiMeanReversion.warmupFor({ ...P, period: 50 })).toBe(52);
  });
  it('fails closed on a missing param', () => {
    const noPeriod = { buyBelow: 30, sellAbove: 70, fraction: 0.5 };
    expect(() => rsiMeanReversion.onCandle(ctxFor([10, 9, 8, 7, 8], 100_000_000n, 0n, noPeriod))).toThrow(/rsi-mean-reversion: param period/);
    expect(() => rsiMeanReversion.warmupFor(noPeriod)).toThrow(/period/);
  });
  it('is registered under its id', () => {
    expect(STRATEGIES['rsi-mean-reversion']).toBe(rsiMeanReversion);
  });
});
