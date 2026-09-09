/**
 * `@ctb/candles` owns the price scale and the Decimal parse, and `@ctb/reports` may not import it —
 * this package imports nothing at runtime (`purity.guard.test.ts`), so two consumers (cli, dashboard)
 * can agree on these functions without either dragging a database in. It is therefore restated here,
 * ONCE, and pinned to candles' real output by `baseDenominatedParity.test.ts` in the cli package.
 *
 * That pin covers the Decimal SHAPE and the truncation rule, not the scale constant: every consumer
 * below divides one parsed price by another, so a uniformly different scale cancels and is harmless.
 * A misread FORMAT is not harmless, and that is what the pin catches.
 */
export const PRICE_SCALE = 18;
export const PRICE_UNIT = 10n ** BigInt(PRICE_SCALE);

/**
 * A Decimal price string (ADA per WHOLE token) to a bigint scaled by 10^PRICE_SCALE.
 *
 * Null for anything not strictly positive, and null rather than 0 for an unparseable one: every
 * caller divides by this, so a bad price makes its answer UNMEASURABLE. Returning 0 would let a
 * caller report a confident number built on a price nobody could read.
 */
export function priceScaled(price: string): bigint | null {
  const m = /^(-?\d+)(?:\.(\d*))?$/.exec(price.trim());
  if (m === null) return null;
  const scaled = BigInt(m[1]! + (m[2] ?? '').padEnd(PRICE_SCALE, '0').slice(0, PRICE_SCALE));
  return scaled > 0n ? scaled : null;
}

/**
 * `b / a` as a plain number, taken in bigint first so the division does not depend on either price
 * fitting in a double. Twelve significant digits, which is far more than any ratio here is worth.
 * A ratio beyond ~1e4 starts to lose digits off the end; that is a 10,000x price move, where the
 * answer is "catastrophic" long before the twelfth digit matters.
 */
const RATIO_SCALE = 1_000_000_000_000n;
export function ratioOf(a: bigint, b: bigint): number {
  return Number((b * RATIO_SCALE) / a) / 1e12;
}
