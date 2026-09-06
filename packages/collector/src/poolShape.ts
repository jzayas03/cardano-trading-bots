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
