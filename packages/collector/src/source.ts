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
