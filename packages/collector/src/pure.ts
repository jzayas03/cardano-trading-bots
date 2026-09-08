/**
 * `@ctb/collector`'s pure entry point: the whole public surface of `./index.js` EXCEPT the
 * `dexterSource.js` re-export.
 *
 * Why this file exists (do not "simplify" it back into one entry point):
 * `dexterSource.ts` is the only module in this package that imports `@indigo-labs/dexter`, and
 * Dexter is heavy — it pulls in `lucid-cardano` and WebAssembly, ships extensionless ESM imports
 * that plain Node cannot resolve, and cannot be pre-bundled by Vite/Vitest (see
 * `vitest.config.ts`'s `server.deps.inline`, and the failed attempt to enable the dependency
 * optimizer for it instead, which breaks with `Cannot destructure property '__extends' of
 * 'import_tslib.default'`).
 *
 * Because `./index.ts` re-exports `dexterSource.js`, EVERY consumer that imports anything from
 * `@ctb/collector` — even just the `Logger` type or `isDexName` — drags the entire Dexter/Lucid/WASM
 * dependency into vitest's module graph for that file. Under load this has caused real failures:
 * a worker's fetch of `@indigo-labs/dexter/build/dex/models/asset.js` timed out and reddened a test
 * that touches neither Dexter nor a database.
 *
 * Import from here (`@ctb/collector/pure`) instead of `@ctb/collector` whenever the consumer does
 * not need `DefaultPoolFetcher`, `DexterPoolSource`, or `toPoolLike`. As of this writing, only the
 * `collect` CLI command and this package's own Dexter-facing tests need the full `@ctb/collector`
 * entry — everything else (venue tables, snapshot bucketing, the Postgres repo, retry helpers,
 * `runTick`, and all the shared types) lives here and never touches Dexter.
 *
 * `index.ts` re-exports this file's surface (plus `dexterSource.js`) rather than duplicating the
 * export list, so the two entry points cannot drift apart.
 */
export type { Logger, PoolAsset, PoolLike, SnapshotRow } from './types.js';
export { VENUES, VENUE_NAMES, DEFAULT_VENUES, isDexName, type DexName } from './venues.js';
export { bucketTick, poolIdOf, poolToSnapshot, reconcileTickTs } from './snapshot.js';
export { PgSnapshotRepo, type CachedPool, type PoolCacheRepo, type RestartState, type RunError, type RunRow, type RunSummary, type SnapshotRepo, type VenuePoolCount } from './repo.js';
export type { DiscoveryCallsSource, HydratableSource, PoolSource, SourceResult } from './source.js';
export { DEFAULT_DISCOVERY_COST, freshState, isPoolFailure, runTick, utcDay, type CollectorState, type TickDeps } from './tick.js';
export { isTransientHttpError, retryWithBackoff, type RetryOptions } from './retry.js';
