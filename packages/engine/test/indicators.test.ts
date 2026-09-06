import { describe, expect, it } from 'vitest';
import { crossed, ema, pctChange, rsi, sma, spikeRatio } from '../src/index.js';

describe('indicators', () => {
  it('sma', () => {
    expect(sma([1, 2, 3, 4], 3)).toBe(3);
    expect(sma([1, 2], 3)).toBeNull();
  });
  it('ema seeds with sma then smooths (period 3, k=0.5)', () => {
    expect(ema([1, 2, 3], 3)).toBe(2);
    expect(ema([1, 2, 3, 4], 3)).toBe(3);
    expect(ema([1, 2], 3)).toBeNull();
  });
  it('rsi(3) on [10, 11, 10.5, 11.5] is 80 (hand computed: RS = (2/3)/(1/6) = 4)', () => {
    expect(rsi([10, 11, 10.5, 11.5], 3)).toBeCloseTo(80, 9);
  });
  it('rsi is 100 on a monotone rise and 0 on a monotone fall', () => {
    expect(rsi([1, 2, 3, 4, 5], 3)).toBe(100);
    expect(rsi([5, 4, 3, 2, 1], 3)).toBe(0);
  });
  it('rsi needs period+1 closes', () => {
    expect(rsi([1, 2, 3], 3)).toBeNull();
  });
  it('rsi smooths after the seed (Wilder)', () => {
    // seed over first 3 changes of [10,11,10.5,11.5] = gain 2/3, loss 1/6; next change +0.5:
    // gain = (2/3*2 + 0.5)/3 = 0.6111.., loss = (1/6*2 + 0)/3 = 0.1111.. ; RS = 5.5 ; RSI = 84.615..
    expect(rsi([10, 11, 10.5, 11.5, 12], 3)).toBeCloseTo(100 - 100 / 6.5, 9);
  });
  it('pctChange', () => {
    expect(pctChange([100, 110, 121], 2)).toBeCloseTo(0.21, 12);
    expect(pctChange([100], 1)).toBeNull();
  });
  it('spikeRatio ignores nulls in the baseline and requires a non-null last', () => {
    expect(spikeRatio([1, null, 1, 1, 3], 3)).toBe(3);
    expect(spikeRatio([1, 1, 1, null], 3)).toBeNull();
    expect(spikeRatio([1, 1, 3], 3)).toBeNull();
  });
  it('crossed', () => {
    expect(crossed(1, 2, 3, 2)).toBe('up');
    expect(crossed(3, 2, 1, 2)).toBe('down');
    expect(crossed(3, 2, 4, 2)).toBeNull();
    expect(crossed(2, 2, 3, 2)).toBe('up'); // touching then above counts as a cross
  });
});
