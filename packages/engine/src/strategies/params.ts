/**
 * `params` is always the strategy defaults merged with the run's overrides, so a missing key means
 * the caller built the params object wrong — not that the default applies. `?? 12` silently ran a
 * strategy on numbers nobody chose and reported the result as if they had (finding M8). Every
 * strategy reads its params through this, so the failure is the same one everywhere.
 */
export function requireParam(strategyId: string, params: Record<string, number>, key: string): number {
  const v = params[key];
  if (v === undefined || !Number.isFinite(v)) throw new Error(`${strategyId}: param ${key} is missing or not finite`);
  return v;
}

/**
 * Smallest buy any strategy emits.
 *
 * **Was 5 ADA, which was indefensible and nobody had done the division.** The fixed cost of an order
 * is ~2.20 ADA (batcher + network), so on a 5 ADA buy the fixed cost alone is **44% of the order** —
 * the fees do not "eat" it, they take nearly half.
 *
 * 100 ADA is derived, not chosen: `2.20 / 0.0216 ~= 102 ADA` is the size at which the fixed cost
 * equals the entire measured 216 bps ROUND-TRIP floor. Below roughly this, one leg's fixed cost
 * exceeds what a full round trip is supposed to cost, and the order cannot be justified at any
 * signal quality. Raise the measured floor or the fee and this number moves with them.
 */
export const MIN_BUY_LOVELACE = 100_000_000n;

/** `fraction` of the cash balance, in lovelace, with the fraction carried to four places. */
export function cashFraction(cashLovelace: bigint, fraction: number): bigint {
  return (cashLovelace * BigInt(Math.round(fraction * 10_000))) / 10_000n;
}
