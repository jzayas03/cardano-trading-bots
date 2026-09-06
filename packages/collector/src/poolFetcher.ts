import type { LiquidityPoolShape } from './poolShape.js';
import type { DexName } from './venues.js';

/** Structural view of Dexter's `Asset` so this file needs no Dexter import. */
export interface FetcherAsset {
  policyId: string;
  nameHex: string;
  decimals: number;
}

/**
 * The seam between `DexterPoolSource` and the chain. `DexterPoolSource`'s default fetcher wraps
 * Dexter exactly as before; unit tests inject a fake here instead of constructing a real network
 * call, so `discover()`/`refresh()` can be tested without Blockfrost (reviewer finding F17).
 */
export interface PoolFetcher {
  /** One venue's on-chain liquidity pools for the given token pairs. */
  discoverVenue(venue: DexName, tokenPairs: Array<['lovelace', FetcherAsset]>): Promise<LiquidityPoolShape[]>;
  /** The latest on-chain state for one already-known pool, or `undefined` if none came back. */
  poolState(pool: LiquidityPoolShape): Promise<LiquidityPoolShape | undefined>;
}
