import type { PoolAsset, PoolLike, SnapshotRow } from './types.js';
import { VENUES, isDexName } from './venues.js';

export function poolIdOf(pool: Pick<PoolLike, 'dex' | 'identifier'>): string {
  return `${pool.dex}:${pool.identifier}`;
}

export function bucketTick(at: Date, intervalSec: number): Date {
  const ms = intervalSec * 1000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

function unitOf(asset: Exclude<PoolAsset, 'lovelace'>): string {
  return asset.policyId + asset.nameHex;
}

/** Pure. Throws instead of guessing: an unknown venue, a non-ADA pair, or a nonsense fee is a bug upstream. */
export function poolToSnapshot(
  pool: PoolLike,
  ctx: { tickTs: Date; blockHeight: number; observedAt: Date },
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
  };
}
