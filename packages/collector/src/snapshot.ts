import type { PoolAsset, PoolLike, SnapshotRow } from './types.js';
import { VENUES, isDexName } from './venues.js';

export function poolIdOf(pool: Pick<PoolLike, 'dex' | 'identifier'>): string {
  return `${pool.dex}:${pool.identifier}`;
}

export function bucketTick(at: Date, intervalSec: number): Date {
  const ms = intervalSec * 1000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

/**
 * The timestamp a tick should carry, given the boundary its caller pinned before sleeping and the
 * moment it actually woke.
 *
 * A caller pins the boundary BEFORE sleeping because re-deriving it from `now()` on an EARLY wake
 * can bucket one interval earlier than the boundary actually slept for (finding F7). That reasoning
 * holds — but it left the LATE wake unhandled, and a laptop suspends. Measured over 118 ticks on
 * 2026-09-07: 35 were stamped more than two minutes before the moment they were observed, the worst
 * by 69 minutes, because the machine slept through several boundaries while the label stayed fixed.
 *
 * That label is not cosmetic. Candles are bucketed by it, the paper clock reads candles by it, and
 * the executor's stale-fill bound compares it to decide whether data is too old to trade against —
 * so a stale label makes the executor believe data is FRESHER than it is, the exact inverse of what
 * that bound exists to do.
 *
 * The rule: never earlier than the boundary that was slept toward, and never earlier than the bucket
 * the clock is actually in. Boundaries missed while suspended are simply not collected; backfilling
 * them would be inventing observations nobody made.
 */
export function reconcileTickTs(pinned: Date, now: Date, intervalSec: number): Date {
  const actual = bucketTick(now, intervalSec);
  return actual.getTime() > pinned.getTime() ? actual : pinned;
}

function unitOf(asset: Exclude<PoolAsset, 'lovelace'>): string {
  return asset.policyId + asset.nameHex;
}

/** Pure. Throws instead of guessing: an unknown venue, a non-ADA pair, or a nonsense fee is a bug upstream. */
export function poolToSnapshot(
  pool: PoolLike,
  ctx: { tickTs: Date; blockHeight: number; observedAt: Date; isPrimary?: boolean },
): SnapshotRow {
  if (!isDexName(pool.dex)) throw new Error(`unknown venue ${pool.dex} for pool ${pool.identifier}`);
  const aIsAda = pool.assetA === 'lovelace';
  const bIsAda = pool.assetB === 'lovelace';
  if (aIsAda === bIsAda) throw new Error(`not an ADA pair: ${poolIdOf(pool)}`);
  const base = (aIsAda ? pool.assetB : pool.assetA) as Exclude<PoolAsset, 'lovelace'>;
  const reserveBase = aIsAda ? pool.reserveB : pool.reserveA;
  const reserveQuote = aIsAda ? pool.reserveA : pool.reserveB;
  if (!Number.isFinite(pool.poolFeePercent) || pool.poolFeePercent < 0 || pool.poolFeePercent > 100) {
    throw new Error(`fee out of range for ${poolIdOf(pool)}: ${pool.poolFeePercent}`);
  }
  return {
    tickTs: ctx.tickTs,
    dex: pool.dex,
    poolId: poolIdOf(pool),
    poolAddress: pool.address,
    baseUnit: unitOf(base),
    quoteUnit: 'lovelace',
    reserveBase,
    reserveQuote,
    feeBps: Math.round(pool.poolFeePercent * 100),
    poolType: VENUES[pool.dex].poolType,
    tvlLovelace: 2n * reserveQuote,
    blockHeight: ctx.blockHeight,
    observedAt: ctx.observedAt,
    // Defaults TRUE: every caller that predates multi-venue sampling produced a deepest-pool
    // observation, and a row that forgot the flag must not silently become invisible to candles.
    isPrimary: ctx.isPrimary ?? true,
  };
}
