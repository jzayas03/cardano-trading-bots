import { describe, expect, it } from 'vitest';
import { cpmmAmountOut, poolFeeTaken } from '../src/index.js';

// Live SundaeSwapV3 SNEK/ADA pool, 2026-09-05: quote (lovelace) 52 331 970 594, base (SNEK, 0 dec) 23 779 491, fee 100 bps.
const RQ = 52_331_970_594n;
const RB = 23_779_491n;

describe('cpmmAmountOut', () => {
  it('buying with 1000 ADA yields 441 500 SNEK', () => {
    expect(cpmmAmountOut(1_000_000_000n, RQ, RB, 100)).toBe(441_500n);
  });
  it('selling 1 000 000 SNEK yields 2 091 631 632 lovelace', () => {
    expect(cpmmAmountOut(1_000_000n, RB, RQ, 100)).toBe(2_091_631_632n);
  });
  it('a dust buy yields zero', () => {
    expect(cpmmAmountOut(1n, RQ, RB, 0)).toBe(0n);
  });
  it('never returns more than the output reserve', () => {
    expect(cpmmAmountOut(10n ** 30n, RQ, RB, 0)).toBeLessThan(RB);
  });
  it('fails closed on bad inputs', () => {
    expect(() => cpmmAmountOut(1n, 0n, RB, 30)).toThrow(/reserve/);
    expect(() => cpmmAmountOut(-1n, RQ, RB, 30)).toThrow(/amount/);
    expect(() => cpmmAmountOut(1n, RQ, RB, 10_000)).toThrow(/fee/);
  });
  it('poolFeeTaken floors', () => {
    expect(poolFeeTaken(1_000_000_000n, 100)).toBe(10_000_000n);
    expect(poolFeeTaken(99n, 100)).toBe(0n);
  });
});
