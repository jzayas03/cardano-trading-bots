import type { Pair } from '@ctb/universe';
import type { CachedPool, RunError } from './repo.js';
import type { PoolLike } from './types.js';

export interface SourceResult {
  pools: PoolLike[];
  failures: RunError[];
}

/** What the tick runner needs from the chain. Implemented by DexterPoolSource; faked in tests. */
export interface PoolSource {
  /** Expensive: scans every pool of every venue on-chain, keeps the matches for `refresh`. */
  discover(pairs: Pair[]): Promise<SourceResult>;
  /**
   * Cheap: one provider call per known pool.
   *
   * `onlyBaseUnits`, when given, refreshes just those tokens. That is what lets one token be
   * sampled far more often than the rest inside the same Blockfrost budget — the point being a
   * real high and low, which one sample per candle cannot produce.
   */
  refresh(onlyBaseUnits?: ReadonlySet<string>): Promise<SourceResult>;
  tip(): Promise<{ height: number; time: Date }>;
  providerCalls(): number;
  resetProviderCalls(): void;
  knownPoolCount(): number;
}

/**
 * Optional capability some `PoolSource` implementations expose: per-venue provider-call counts from
 * the most recent `discover()` (currently only `DexterPoolSource`, which tracks real Blockfrost calls
 * via its counting provider). Deliberately NOT part of `PoolSource` itself, so every existing
 * `PoolSource` fake in the test suite needs no changes — `tick.ts` checks for this structurally
 * instead of widening the required interface.
 */
export interface DiscoveryCallsSource {
  lastDiscoveryCalls(): Record<string, number>;
}

/**
 * Optional capability, structural like `DiscoveryCallsSource`: venues that returned no pools at the
 * last discovery, and a way to try just those again. A venue lost to a transient Blockfrost 504 at
 * 00:20 UTC on 2026-09-07 (MinswapV2, the deepest pool for 19 of 20 tokens) otherwise stayed out
 * until the next full discovery 24 hours later.
 */
export interface RediscoverySource {
  lostVenues(): string[];
  /** Discovers the lost venues only; found pools join the known set (pruned per the refresh policy). */
  rediscover(pairs: Pair[]): Promise<SourceResult>;
}

/**
 * Optional capability, structural like the two above: a `PoolSource` whose known-pool set can be
 * seeded from storage and read back out for persisting.
 *
 * This is what stops a RESTART from costing a discovery sweep. `runTick` treats an empty known set
 * as "discovery is due" -- correct for a genuinely fresh universe, and ruinous for a process that
 * simply restarted, because the set lives only in memory. Measured on 2026-09-08: five collector
 * restarts bought five sweeps, 25,174 of the day's 43,469 Blockfrost calls, and the free tier ran
 * out at 20:15 UTC with the collector then failing closed on every tick for the rest of the day.
 *
 * `hydrate` returns the number of pools taken, so a caller can log the difference between a warm
 * start and a cold one instead of guessing which happened.
 */
export interface HydratableSource {
  hydrate(pools: readonly CachedPool[]): number;
  /** The known set, in the exact shape `hydrate` accepts. Empty before the first discovery. */
  cachedPools(): CachedPool[];
}

/**
 * Optional capability, structural like the others: price the venues that `'deepest'` pruning set
 * aside, so the same pair can be compared across DEXes at the same instant.
 *
 * Measured 2026-09-09, before this existed: 11 total cross-venue observations, all from once-a-day
 * discovery ticks. Where both venues were deep (USDA, 1.68M and 1.66M ADA) the spread was 14 bps;
 * where one was shallow (NIGHT, 2.36M against 244k) it was 404 bps and cleared the round-trip floor
 * in every observation — large because closing it was uneconomic, not because it was an opportunity.
 * Telling those apart needs many observations, not one a day.
 */
export interface MultiVenueSource {
  secondaryPoolCount(minAdaLovelace: bigint): number;
  refreshSecondary(minAdaLovelace: bigint): Promise<SourceResult>;
}
