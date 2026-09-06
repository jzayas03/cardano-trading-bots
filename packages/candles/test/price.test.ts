import { describe, expect, it } from 'vitest';
import { decimalToNumber, priceAdaPerToken } from '../src/index.js';

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
