import { describe, expect, it } from 'vitest';
import { decimalToScaled, formatScaled, PRICE_SCALE, priceAdaPerToken } from '@ctb/candles';
import type { EquityPoint } from '@ctb/engine';
import { summarizeRun, tokenStr } from '@ctb/reports';

/**
 * `@ctb/reports` may not import `@ctb/candles` (`purity.guard.test.ts`: it imports nothing at
 * runtime), so it restates the price scale and re-implements the Decimal parse. This test is the
 * pin, and it lives here because `@ctb/cli` is the one package that depends on both.
 *
 * What it pins is the DECIMAL SHAPE and the truncation rule — that reports still recognises what
 * candles emits, and rounds it the same way. It does NOT pin the scale constant itself, and cannot:
 * the restatement divides by the parsed price, so a uniformly different scale cancels out. That is
 * a real property, not a hole — a consistently wrong scale is harmless; a misread FORMAT is not,
 * and a format reports cannot parse turns the whole column null, which is what this catches.
 */
const eq = (equityLovelace: bigint, price: string, hour = 0): EquityPoint => ({
  tickTs: new Date(Date.UTC(2026, 8, 6, hour)), cashLovelace: 0n, positionBase: 0n,
  equityLovelace, equityExecutableLovelace: null, price,
});

const EQUITY = 1_000_000_000n;
/** Reserve pairs spanning the real range: a sub-cent token, a ~1 ADA token, and a dear one. */
const POOLS: Array<[bigint, bigint, number]> = [
  [4_720_000_000_000n, 2_360_000_000_000n, 6], // ~0.002 ADA/token
  [1_000_000_000_000n, 1_000_000n, 0],         // 1,000,000 ADA/token
  [3_333_000_000n, 7_000_000_000n, 6],         // a price that does not terminate
];

describe('reports restates prices in the shape candles actually emits', () => {
  it('parses every price candles produces, and to the same magnitude', () => {
    for (const [quote, base, decimals] of POOLS) {
      const price = priceAdaPerToken(quote, base, decimals);
      const expected = tokenStr((EQUITY * 10n ** BigInt(PRICE_SCALE)) / decimalToScaled(price));
      const s = summarizeRun([eq(EQUITY, price)], []);
      expect(s.startBaseTokens, `price ${price}`).toBe(expected);
      expect(s.startBaseTokens, `price ${price}`).not.toBeNull();
    }
  });

  it('truncates a longer-than-scale price exactly as decimalToScaled does', () => {
    // candles' own formatScaled emits exactly PRICE_SCALE places, but decimalToScaled ACCEPTS more
    // and truncates. If reports rounded instead of truncating, the two would part company here.
    const long = `0.${'1'.repeat(PRICE_SCALE + 4)}`;
    const expected = tokenStr((EQUITY * 10n ** BigInt(PRICE_SCALE)) / decimalToScaled(long));
    expect(summarizeRun([eq(EQUITY, long)], []).startBaseTokens).toBe(expected);
  });

  it('treats a short price and its zero-padded form as the same number', () => {
    const short = summarizeRun([eq(EQUITY, '0.002')], []).startBaseTokens;
    const padded = summarizeRun([eq(EQUITY, formatScaled(decimalToScaled('0.002')))], []).startBaseTokens;
    expect(short).toBe(padded);
    expect(short).toBe('500000.000000');
  });

  it('an integer-valued price (no decimal point) still parses', () => {
    // formatScaled always writes a point, but nothing guarantees every producer will.
    expect(summarizeRun([eq(EQUITY, '2')], []).startBaseTokens).toBe('500.000000');
  });
});
