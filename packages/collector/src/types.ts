import type { DexName } from './venues.js';

export type PoolAsset = 'lovelace' | { policyId: string; nameHex: string };

/** The subset of Dexter's LiquidityPool the collector reads. Structural so tests never import Dexter. */
export interface PoolLike {
  dex: string;
  identifier: string;
  address: string;
  assetA: PoolAsset;
  assetB: PoolAsset;
  reserveA: bigint;
  reserveB: bigint;
  /** Percent, as Dexter reports it: 1 means 1%. */
  poolFeePercent: number;
}

export interface SnapshotRow {
  tickTs: Date;
  dex: DexName;
  poolId: string;
  poolAddress: string;
  baseUnit: string;
  quoteUnit: 'lovelace';
  reserveBase: bigint;
  reserveQuote: bigint;
  feeBps: number;
  poolType: 'cpmm';
  /** 2 x ADA reserve: the usual AMM approximation. Used only to pick the deepest pool. */
  tvlLovelace: bigint;
  blockHeight: number;
  observedAt: Date;
}

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
