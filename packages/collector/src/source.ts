import type { Pair } from '@ctb/universe';
import type { RunError } from './repo.js';
import type { PoolLike } from './types.js';

export interface SourceResult {
  pools: PoolLike[];
  failures: RunError[];
}

/** What the tick runner needs from the chain. Implemented by DexterPoolSource; faked in tests. */
export interface PoolSource {
  /** Expensive: scans every pool of every venue on-chain, keeps the matches for `refresh`. */
  discover(pairs: Pair[]): Promise<SourceResult>;
  /** Cheap: one provider call per known pool. */
  refresh(): Promise<SourceResult>;
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
