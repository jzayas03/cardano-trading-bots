import { describe, expect, it } from 'vitest';
import { decimalToNumber, decimalToScaled, formatScaled, priceAdaPerToken } from '../src/index.js';

describe('priceAdaPerToken', () => {
  it('matches the live SundaeSwapV3 SNEK/ADA pool (0 decimals)', () => {
    const p = priceAdaPerToken(52_331_970_594n, 23_779_491n, 0);
    expect(p.startsWith('0.0022007187031042')).toBe(true);
    expect(p.split('.')[1]).toHaveLength(18);
  });

  it('scales by token decimals', () => {
    // 1 000 000 ADA of lovelace vs 2 000 000 000 000 of a 6-decimal token = 0.5 ADA per token
    expect(priceAdaPerToken(1_000_000_000_000n, 2_000_000_000_000n, 6)).toBe('0.500000000000000000');
    // same reserves, 0 decimals: 0.0000005 ADA per unit
    expect(priceAdaPerToken(1_000_000_000_000n, 2_000_000_000_000n, 0)).toBe('0.000000500000000000');
  });

  it('rejects zero reserves', () => {
    expect(() => priceAdaPerToken(0n, 1n, 0)).toThrow(/reserve/);
    expect(() => priceAdaPerToken(1n, 0n, 0)).toThrow(/reserve/);
  });

  it('decimalToNumber round-trips a normal price', () => {
    expect(decimalToNumber('0.500000000000000000')).toBeCloseTo(0.5, 12);
  });
});

/**
 * Finding M3: three packages had grown their own copy of the split/pad/BigInt dance to get a price
 * back into arithmetic, and one of them (the executor) had a float shortcut sitting next to it. One
 * parser, exported, tested — and it is the exact inverse of formatScaled.
 */
describe('decimalToScaled', () => {
  it('is the exact inverse of formatScaled', () => {
    for (const scaled of [0n, 1n, 2_200_718_703_104_284n, 10n ** 18n, 123_456_789n * 10n ** 9n]) {
      expect(decimalToScaled(formatScaled(scaled))).toBe(scaled);
    }
  });

  it('accepts short and integer forms and pads to 18 places', () => {
    expect(decimalToScaled('0.5')).toBe(500_000_000_000_000_000n);
    expect(decimalToScaled('2')).toBe(2n * 10n ** 18n);
    expect(decimalToScaled('0.00222')).toBe(2_220_000_000_000_000n);
  });

  it('truncates beyond 18 places rather than rounding, matching formatScaled', () => {
    expect(decimalToScaled(`0.${'0'.repeat(17)}19`)).toBe(1n);
  });

  it('fails closed on anything that is not a non-negative decimal', () => {
    for (const bad of ['', 'abc', '1.2.3', '-1', '1e18', 'NaN']) {
      expect(() => decimalToScaled(bad), bad).toThrow(/non-negative decimal/);
    }
  });
});
