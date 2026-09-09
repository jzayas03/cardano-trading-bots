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
  /**
   * `DexName` for every real snapshot the collector writes (`poolToSnapshot` only ever produces a
   * `DexName`, since it throws on `!isDexName(pool.dex)` before it gets here). `'Fake'` is not a
   * Dexter venue — `isDexName('Fake')` stays false — and is written ONLY by `dev:fake-collector`
   * (Plan 3 Task 6), which builds this row directly instead of going through `poolToSnapshot`.
   * Synthetic data can never be mistaken for real (global constraint): a `'Fake'` row is what lets
   * `paper.ts` detect rehearsal data left behind in the database and refuse a non-`--rehearsal` run.
   */
  dex: DexName | 'Fake';
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
  /**
   * False for a multi-venue observation — a pool sampled only to measure cross-DEX spread, never to
   * price a candle. `readSnapshotsSince` filters these out, because `buildCandles` re-picks the
   * deepest pool per bucket and a secondary pool that was momentarily deeper would splice the
   * candle series mid-run. See `0009_snapshot_primary_flag.sql`.
   */
  isPrimary: boolean;
}

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
