import type { RunError } from './repo.js';
import { poolIdOf } from './snapshot.js';
import type { PoolLike } from './types.js';

/** Structural view of Dexter's LiquidityPool so unit tests need no Dexter import. */
export interface LiquidityPoolShape {
  dex: string;
  identifier: string;
  address: string;
  assetA: 'lovelace' | { policyId: string; nameHex: string; decimals: number };
  assetB: 'lovelace' | { policyId: string; nameHex: string; decimals: number };
  reserveA: bigint;
  reserveB: bigint;
  poolFeePercent: number;
}

export function toPoolLike(p: LiquidityPoolShape): PoolLike {
  if (!p.address) throw new Error(`pool ${p.dex}:${p.identifier} has no address; it cannot be refreshed`);
  const side = (a: LiquidityPoolShape['assetA']) => (a === 'lovelace' ? 'lovelace' : { policyId: a.policyId, nameHex: a.nameHex });
  return {
    dex: p.dex,
    identifier: p.identifier,
    address: p.address,
    assetA: side(p.assetA),
    assetB: side(p.assetB),
    reserveA: p.reserveA,
    reserveB: p.reserveB,
    poolFeePercent: p.poolFeePercent,
  };
}

export interface PoolShapeCollectionResult<T extends LiquidityPoolShape> {
  kept: Array<{ id: string; pool: PoolLike; shape: T }>;
  failures: RunError[];
}

/**
 * Maps every shape in one venue's result list through `toPoolLike`, isolating each pool's mapping
 * so one malformed pool (e.g. an unexpected empty `address`) can't drop the rest of the venue's
 * list. Pure — no network, no logging; the caller decides what to do with `failures`.
 */
export function collectPoolShapes<T extends LiquidityPoolShape>(
  venue: string,
  shapes: readonly T[],
): PoolShapeCollectionResult<T> {
  const kept: Array<{ id: string; pool: PoolLike; shape: T }> = [];
  const failures: RunError[] = [];
  for (const shape of shapes) {
    try {
      const pool = toPoolLike(shape);
      kept.push({ id: poolIdOf(pool), pool, shape });
    } catch (err) {
      failures.push({ scope: `discover:${venue}:${shape.identifier}`, message: (err as Error).message ?? String(err) });
    }
  }
  return { kept, failures };
}

export interface RefreshedShapeResult {
  kept?: { pool: PoolLike; shape: LiquidityPoolShape };
  failure?: RunError;
}

/**
 * Maps one refreshed pool's shape through `toPoolLike`, isolating its own failure so one malformed
 * pool state (e.g. an unexpected empty `address`) can't reject the whole `Promise.allSettled` forEach
 * in `DexterPoolSource.refresh()` — a throw there previously escaped uncaught and failed the entire
 * refresh, writing zero snapshots for the tick (reviewer finding F2). Pure — no network, no logging.
 */
export function collectRefreshedShape(poolId: string, shape: LiquidityPoolShape): RefreshedShapeResult {
  try {
    const pool = toPoolLike(shape);
    return { kept: { pool, shape } };
  } catch (err) {
    return { failure: { scope: `refresh:${poolId}`, message: (err as Error).message ?? String(err) } };
  }
}
