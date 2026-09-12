import { cpmmAmountOut } from './cpmm.js';

/**
 * Is this pool deep enough that a comparison against it means anything?
 *
 * `pool_snapshots` records every venue a token trades on, and most of them are abandoned. SNEK on
 * 2026-09-12 sat in six pools: MinswapV2 with 3.8M ADA, WingRidersV2 with 316K, and then
 * SundaeSwapV1 with 16.7K, WingRiders v1 with 7.7K and MuesliSwap with 1.4K. Those last three carry
 * stale reserves nobody trades against, and their prices sit thousands of basis points away —
 * SundaeSwapV1 alone averaged -1,675 bps from the deepest pool.
 *
 * Differencing prices across that set reports ~5,000 bps of "arbitrage" on every tick, none of it
 * tradeable. The two pools with real depth agreed to 7 bps. So a depth filter is not a refinement of
 * a cross-venue comparison; it is the precondition for one meaning anything.
 *
 * **Depth is measured against a trade, not in the abstract.** A pool is not "big" or "small" — it is
 * big enough for the size you intend, or it is not. `sizeLovelace` is therefore required, with no
 * default: naming the trade is the point. A 100 ADA buy (the engine's `MIN_BUY_LOVELACE`) is the
 * natural probe, because below that the fixed fees already exceed a whole round trip's floor.
 */

/**
 * Price impact in basis points of spending `sizeLovelace` on the base token, EXCLUDING the pool fee.
 *
 * The fee is a cost, not a depth property — a 100 bps venue is not shallower than a 30 bps one, it is
 * dearer, and the cost table in `costs.ts` already accounts for that. Passing `feeBps: 0` to
 * `cpmmAmountOut` isolates the part that is purely about reserve size.
 *
 * For constant product this reduces to `sizeLovelace / reserveQuote`, but it is computed through
 * `cpmmAmountOut` deliberately: that identity holds only for this curve with no fee, and one
 * constant-product implementation in the repo is the rule. A second one is how two numbers start
 * disagreeing (same reasoning as `DEFAULT_FLOOR_BPS` being cited rather than re-derived).
 *
 * Returns `Infinity` when the pool cannot fill the trade at all (empty reserves, or an output that
 * rounds to zero), so every caller's comparison against a budget excludes it without a special case.
 */
/** Fixed-point scale for the two lovelace-per-token prices this compares. */
const PRICE_SCALE = 1_000_000_000_000n;
const BPS = 10_000n;
/** The ratio is taken in hundredths of a bps, so a sub-bps impact survives integer division. */
const HUNDREDTHS = 10_000n;

export function priceImpactBps(sizeLovelace: bigint, reserveQuote: bigint, reserveBase: bigint): number {
  if (sizeLovelace <= 0n) throw new Error(`depth probe needs a positive size, got ${sizeLovelace}`);
  if (reserveQuote <= 0n || reserveBase <= 0n) return Infinity;

  const out = cpmmAmountOut(sizeLovelace, reserveQuote, reserveBase, 0);
  if (out <= 0n) return Infinity;

  // Both prices are lovelace per base unit, carried at PRICE_SCALE so the ratio keeps its precision,
  // and the ratio is then taken in hundredths of a basis point for the same reason. Every division
  // here is integer division, and the deepest pool on Cardano produces the smallest number: 100 ADA
  // into MinswapV2's 1.86e12 lovelace is 0.52 bps. A first version scaled by only 1e4 at each step,
  // which made `diff * 10_000` smaller than the mid price itself and floored EVERY pool to exactly
  // zero — reporting the whole corpus as costless and passing the filter unanimously.
  const midScaled = (reserveQuote * PRICE_SCALE) / reserveBase;
  const effectiveScaled = (sizeLovelace * PRICE_SCALE) / out;
  if (midScaled <= 0n) return Infinity;

  return Number(((effectiveScaled - midScaled) * BPS * HUNDREDTHS) / midScaled) / Number(HUNDREDTHS);
}

/**
 * The impact budget a pool must fit inside to count as tradeable.
 *
 * 34 bps is not chosen here — it is the price-impact half of the measured round-trip floor
 * (86 bps slippage one way, of which 34 is our own impact and the rest the pool fee), cited from
 * `DEFAULT_FLOOR_BPS`'s own derivation in `@ctb/reports`' opportunity.ts and
 * `docs/specs/2026-09-08-m6-execution.md` §2. A pool that costs more than the whole floor allows for
 * impact cannot participate in a profitable trade of that size, so its price is not a price we could
 * have got.
 *
 * On the 2026-09-12 SNEK corpus this lands in a tenfold gap rather than cutting through a cluster:
 * 0.5 and 6.4 bps on the two live pools, then 61, 265 and 1,402 on the three dead ones.
 */
export const DEFAULT_MAX_IMPACT_BPS = 34;

export interface PoolDepth {
  poolId: string;
  /** Lovelace side of the pair. */
  reserveQuote: bigint;
  /** Token side of the pair. */
  reserveBase: bigint;
}

/** True when `sizeLovelace` can be spent into this pool inside `maxImpactBps` of price impact. */
export function liquidEnough(pool: PoolDepth, sizeLovelace: bigint, maxImpactBps: number = DEFAULT_MAX_IMPACT_BPS): boolean {
  return priceImpactBps(sizeLovelace, pool.reserveQuote, pool.reserveBase) <= maxImpactBps;
}

/**
 * The pools worth comparing, for a trade of `sizeLovelace`.
 *
 * Order is preserved, so a caller that sorted by depth stays sorted. An empty result is a real
 * answer — no venue can absorb this size — and must not be read as "no opportunity"; that is the
 * same failure as a clamped zero on an operator screen.
 */
export function filterByDepth<T extends PoolDepth>(pools: readonly T[], sizeLovelace: bigint, maxImpactBps: number = DEFAULT_MAX_IMPACT_BPS): T[] {
  return pools.filter((p) => liquidEnough(p, sizeLovelace, maxImpactBps));
}
