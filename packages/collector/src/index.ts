/**
 * `@ctb/collector`'s full entry point: everything in `./pure.js` plus `dexterSource.js`, the only
 * module here that imports the heavy `@indigo-labs/dexter` package. Import from `@ctb/collector/pure`
 * instead whenever the consumer does not need `DefaultPoolFetcher`, `DexterPoolSource`, or
 * `toPoolLike` — see `pure.ts`'s header for why that split exists and what breaks if it is merged
 * back into one entry.
 */
export * from './pure.js';
export {
  DefaultPoolFetcher, DexterPoolSource, toPoolLike,
  type DefaultPoolFetcherOptions, type DexterPoolSourceOptions, type FetcherAsset, type LiquidityPoolShape,
  type PoolFetcher, type PoolStateClient, type SplashDiscoveryClient,
} from './dexterSource.js';
