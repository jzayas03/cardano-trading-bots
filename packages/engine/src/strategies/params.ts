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
 * **Was 100 ADA until 2026-09-16, on a derivation whose units did not line up.** That comment read:
 * "`2.20 / 0.0216 ~= 102 ADA` is the size at which the fixed cost equals the entire measured 216 bps
 * ROUND-TRIP floor". 2.20 ADA is ONE LEG's fixed cost; 216 bps is the ROUND-TRIP budget. A round
 * trip pays the fixed cost TWICE, so the consistent version of that same bar is
 * `4.40 / 0.0216 ~= 204 ADA` -- twice what was written.
 *
 * 500 ADA is chosen from measurement rather than from that derivation, because we now have one.
 * `docs/ops/2026-09-16-cost-floor-distribution.md` priced ~20,000 MinswapV2 snapshots across 18
 * pools deeper than 50,000 ADA, and the round-trip cost is strongly U-shaped in order size:
 *
 *     100 ADA   median p90  590.9 bps      <- the old minimum. A 6% move just to break even.
 *     250 ADA               328.3
 *     500 ADA               254.1          <- here
 *    1000 ADA               216.3          <- the cheapest size; also the constitution's floor
 *    2500 ADA               251.5
 *
 * The fixed 4.40 ADA is 440 bps of a 100 ADA round trip and 17.6 bps of a 2,500 ADA one, which is
 * the whole shape: below ~500 ADA the venue's flat fee, not the market, decides whether a trade can
 * win. 216 bps is not a floor that holds across sizes -- it is the MINIMUM of this curve, reached
 * near 1,000 ADA.
 *
 * NOTE `scheduledAccumulation.defaultParams.buyAda` is also 500, so that strategy's ordinary buy
 * sits exactly ON this boundary and passes. What changes is its tail: the schedule now ends with up
 * to 500 ADA unspent rather than up to 100. That is the intended consequence -- a 100 ADA remainder
 * buy was never worth placing.
 *
 * Raise the measured floor or the fee and this number moves with them.
 */
export const MIN_BUY_LOVELACE = 500_000_000n;

/** `fraction` of the cash balance, in lovelace, with the fraction carried to four places. */
export function cashFraction(cashLovelace: bigint, fraction: number): bigint {
  return (cashLovelace * BigInt(Math.round(fraction * 10_000))) / 10_000n;
}
