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
