import { describe, expect, it } from 'vitest';
import { applyFill, equityLovelace, type FillResult } from '../src/index.js';

const filled = (o: Partial<Extract<FillResult, { status: 'filled' }>>): Extract<FillResult, { status: 'filled' }> => ({
  status: 'filled', poolId: 'p', unitIn: 'lovelace', amountIn: 1_000_000_000n, unitOut: 'snek', amountOut: 441_500n, midPrice: '0.0022', fillPrice: '0.0022650',
  poolFeeIn: 10_000_000n, batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n, slippageBps: 292, priceImpactBps: 292, tsFill: new Date(0), ...o,
});

describe('portfolio', () => {
  it('buy debits amountIn plus lovelace fees and credits the position', () => {
    const p = applyFill({ cashLovelace: 5_000_000_000n, positionBase: 0n }, filled({}), 'buy');
    expect(p).toEqual({ cashLovelace: 5_000_000_000n - 1_000_000_000n - 2_200_000n, positionBase: 441_500n });
  });
  it('sell debits the position and credits amountOut minus lovelace fees', () => {
    const p = applyFill({ cashLovelace: 0n, positionBase: 1_000_000n }, filled({ unitIn: 'snek', amountIn: 1_000_000n, unitOut: 'lovelace', amountOut: 2_091_631_632n }), 'sell');
    expect(p).toEqual({ cashLovelace: 2_091_631_632n - 2_200_000n, positionBase: 0n });
  });
  it('refuses to go negative', () => {
    expect(() => applyFill({ cashLovelace: 1n, positionBase: 0n }, filled({}), 'buy')).toThrow(/negative/);
  });
  it('equity values the position at the given price', () => {
    // 441 500 SNEK (0 decimals) at 0.0022 ADA = 971.3 ADA = 971 300 000 lovelace
    expect(equityLovelace({ cashLovelace: 100n, positionBase: 441_500n }, '0.002200000000000000', 0)).toBe(971_300_100n);
    // 6-decimal token: 2.5 tokens at 0.5 ADA = 1.25 ADA
    expect(equityLovelace({ cashLovelace: 0n, positionBase: 2_500_000n }, '0.500000000000000000', 6)).toBe(1_250_000n);
  });
});
