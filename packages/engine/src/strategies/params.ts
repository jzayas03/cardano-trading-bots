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

/** Smallest buy any strategy emits: below this, batcher + network fees eat the order. */
export const MIN_BUY_LOVELACE = 5_000_000n;

/** `fraction` of the cash balance, in lovelace, with the fraction carried to four places. */
export function cashFraction(cashLovelace: bigint, fraction: number): bigint {
  return (cashLovelace * BigInt(Math.round(fraction * 10_000))) / 10_000n;
}
