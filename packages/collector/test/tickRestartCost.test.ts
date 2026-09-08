import { describe, expect, it } from 'vitest';
import type { Pair } from '@ctb/universe';
import {
  DEFAULT_DISCOVERY_COST, runTick, utcDay,
  type CachedPool, type CollectorState, type HydratableSource, type PoolCacheRepo,
  type PoolLike, type PoolSource, type RestartState, type RunSummary, type SnapshotRepo,
  type SnapshotRow, type SourceResult,
} from '../src/pure.js';

/**
 * The 2026-09-08 defect, pinned in both directions.
 *
 * A collector restart lost its pool set and its discovery clock, both of which live only in memory,
 * so `runTick` saw a universe that had never been discovered and bought a full sweep. Five restarts
 * that day bought five sweeps -- 25,174 of the day's 43,469 Blockfrost calls -- and the free tier ran
 * out at 20:15 UTC with the collector then failing closed on a 402 for the rest of the day.
 *
 * Two independent triggers, so two independent things to prove: the pool set must survive a restart,
 * and a sweep must be refused when the day cannot pay for it.
 */

const SNEK_PAIR: Pair = {
  base: { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme',
    unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b' },
  quote: 'lovelace',
};

const pool = (dex: string, id: string): PoolLike => ({
  dex, identifier: id, address: `addr_${id}`, assetA: 'lovelace',
  assetB: { policyId: SNEK_PAIR.base.policyId, nameHex: SNEK_PAIR.base.assetNameHex },
  reserveA: 100n, reserveB: 50n, poolFeePercent: 0.3,
});

const cached = (dex: string, id: string): CachedPool => ({
  poolId: `${dex}:${id}`, dex, identifier: id, address: `addr_${id}`, assetA: 'lovelace',
  assetB: { policyId: SNEK_PAIR.base.policyId, nameHex: SNEK_PAIR.base.assetNameHex, decimals: 0 },
  reserveA: 100n, reserveB: 50n, poolFeePercent: 0.3,
});

/** The real cost shape: a sweep is expensive, a refresh is not. Those two numbers are the whole point. */
const SWEEP_CALLS = 5_692;
const REFRESH_CALLS_PER_POOL = 15;

/** A source that starts EMPTY, exactly like a freshly started process, and can be hydrated. */
class RestartableSource implements PoolSource, HydratableSource {
  discoverCalls = 0;
  refreshCalls = 0;
  calls = 0;
  private known: CachedPool[] = [];
  constructor(private readonly discoverable: PoolLike[]) {}
  hydrate(pools: readonly CachedPool[]): number { this.known = [...pools]; return this.known.length; }
  cachedPools(): CachedPool[] { return [...this.known]; }
  async discover(): Promise<SourceResult> {
    this.discoverCalls++;
    this.calls += SWEEP_CALLS;
    this.known = this.discoverable.map((p) => cached(p.dex, p.identifier));
    return { pools: this.discoverable, failures: [] };
  }
  async refresh(): Promise<SourceResult> {
    this.refreshCalls++;
    this.calls += this.known.length * REFRESH_CALLS_PER_POOL;
    return { pools: this.known.map((k) => pool(k.dex, k.identifier)), failures: [] };
  }
  async tip() { return { height: 42, time: new Date() }; }
  providerCalls() { return this.calls; }
  resetProviderCalls() { this.calls = 0; }
  knownPoolCount() { return this.known.length; }
}

class FakeRepo implements SnapshotRepo, PoolCacheRepo {
  rows: SnapshotRow[] = [];
  summaries: RunSummary[] = [];
  saves: CachedPool[][] = [];
  constructor(private readonly state: RestartState) {}
  async syncTokens() {}
  async startRun() { return this.summaries.length + 1; }
  async insertSnapshots(_runId: number, rows: SnapshotRow[]) { this.rows.push(...rows); return rows.length; }
  async finishRun(_id: number, _at: Date, s: RunSummary) { this.summaries.push({ ...s, errors: [...s.errors] }); }
  async lastRuns() { return []; }
  async restartState() { return this.state; }
  async savePoolCache(pools: readonly CachedPool[]) {
    if (pools.length === 0) throw new Error('refusing to empty the pool cache');
    this.saves.push([...pools]);
    this.state.pools = [...pools];
  }
}

const log = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = new Date('2026-09-08T21:00:00Z');
const emptyState = (): RestartState => ({ lastDiscoveryAt: null, callsSpentToday: 0, lastDiscoveryCost: null, pools: [] });

function deps(source: PoolSource, repo: FakeRepo, state: CollectorState, dailyCallCeiling = 45_000) {
  return {
    source, repo, poolCache: repo, pairs: [SNEK_PAIR], log, now: () => NOW,
    intervalSec: 900, rediscoverAfterMs: 24 * 3600 * 1000, state, dailyCallCeiling,
  };
}

/** State as `collect` builds it: seeded from what the database knows, not from zero. */
function seeded(s: RestartState): CollectorState {
  return { lastDiscoveryAt: s.lastDiscoveryAt, callsSpentToday: s.callsSpentToday, spendDay: utcDay(NOW), lastDiscoveryCost: s.lastDiscoveryCost };
}

describe('a restart must not buy a discovery sweep', () => {
  it('cold start discovers once and persists the pool set', async () => {
    const stored = emptyState();
    const repo = new FakeRepo(stored);
    const source = new RestartableSource([pool('MinswapV2', 'a'), pool('SundaeSwapV3', 'b')]);
    source.hydrate(stored.pools);

    const s = await runTick(deps(source, repo, seeded(stored)));

    expect(s.discovered).toBe(true);
    expect(s.providerCalls).toBe(SWEEP_CALLS);
    // The set was written, which is the only thing that makes the NEXT start cheap.
    expect(repo.saves).toHaveLength(1);
    expect(repo.saves[0]?.map((p) => p.poolId).sort()).toEqual(['MinswapV2:a', 'SundaeSwapV3:b']);
  });

  it('REINJECTION: a restart with no cache pays for a sweep; with the cache it pays for a refresh', async () => {
    // Arrange one shared "database" and fill it by running a cold start.
    const stored = emptyState();
    const cold = new FakeRepo(stored);
    const first = new RestartableSource([pool('MinswapV2', 'a'), pool('SundaeSwapV3', 'b')]);
    await runTick(deps(first, cold, seeded(stored)));
    stored.lastDiscoveryAt = NOW;
    stored.lastDiscoveryCost = SWEEP_CALLS;
    expect(stored.pools).toHaveLength(2);

    // THE DEFECT, reinjected: the process restarts and the cache is ignored, which is precisely what
    // the code did before this change -- an empty known set plus a null clock.
    const brokenRepo = new FakeRepo({ ...stored, pools: [] });
    const broken = new RestartableSource([pool('MinswapV2', 'a'), pool('SundaeSwapV3', 'b')]);
    broken.hydrate([]);
    const brokenSummary = await runTick(deps(broken, brokenRepo, { ...seeded(stored), lastDiscoveryAt: null }));
    expect(brokenSummary.discovered).toBe(true);
    expect(brokenSummary.providerCalls).toBe(SWEEP_CALLS);

    // THE FIX: same restart, hydrated from the cache and with the clock seeded.
    const fixedRepo = new FakeRepo(stored);
    const fixed = new RestartableSource([pool('MinswapV2', 'a'), pool('SundaeSwapV3', 'b')]);
    expect(fixed.hydrate(stored.pools)).toBe(2);
    const fixedSummary = await runTick(deps(fixed, fixedRepo, seeded(stored)));

    expect(fixedSummary.discovered).toBe(false);
    expect(fixed.discoverCalls).toBe(0);
    expect(fixedSummary.providerCalls).toBe(2 * REFRESH_CALLS_PER_POOL);
    // The saving is the finding, so assert its size and not merely its sign.
    expect(brokenSummary.providerCalls - fixedSummary.providerCalls).toBe(SWEEP_CALLS - 30);
    expect(fixedSummary.poolsWritten).toBe(2);
  });

  it('a hydrated start still rediscovers once the clock says the set is a day old', async () => {
    // Hydration must not become a way to never discover again: a stale set is still stale.
    const stored: RestartState = { ...emptyState(), pools: [cached('MinswapV2', 'a')], lastDiscoveryAt: new Date('2026-09-06T21:00:00Z'), lastDiscoveryCost: SWEEP_CALLS };
    const repo = new FakeRepo(stored);
    const source = new RestartableSource([pool('MinswapV2', 'a')]);
    source.hydrate(stored.pools);

    const s = await runTick(deps(source, repo, seeded(stored)));

    expect(s.discovered).toBe(true);
  });
});

describe('the daily call ceiling', () => {
  it('refuses a sweep the day cannot pay for, and says so on the run row', async () => {
    const stored: RestartState = { ...emptyState(), callsSpentToday: 43_469, lastDiscoveryCost: SWEEP_CALLS };
    const repo = new FakeRepo(stored);
    const source = new RestartableSource([pool('MinswapV2', 'a')]);

    const s = await runTick(deps(source, repo, seeded(stored)));

    expect(source.discoverCalls).toBe(0);
    expect(s.discovered).toBe(false);
    expect(s.providerCalls).toBe(0);
    expect(s.errors).toEqual([{ scope: 'budget', message: 'discovery refused: 43469 calls spent today + ~5692 for a sweep = 49161, over the 45000 ceiling' }]);
    // Refused, not silently skipped: the run row carries the reason.
    expect(repo.summaries[0]?.errors[0]?.scope).toBe('budget');
  });

  it('CONTROL: the same tick on a quiet day is allowed through', async () => {
    // The other direction. A ceiling that refuses everything would pass the test above while being
    // useless, and a guard that over-reports gets obeyed.
    const stored: RestartState = { ...emptyState(), callsSpentToday: 10_000, lastDiscoveryCost: SWEEP_CALLS };
    const repo = new FakeRepo(stored);
    const source = new RestartableSource([pool('MinswapV2', 'a')]);

    const s = await runTick(deps(source, repo, seeded(stored)));

    expect(source.discoverCalls).toBe(1);
    expect(s.discovered).toBe(true);
    expect(s.errors).toEqual([]);
  });

  it('prices an unmeasured sweep at DEFAULT_DISCOVERY_COST', async () => {
    // Just under the ceiling on the real cost, over it on the conservative default -- so this fails
    // if the default is ever quietly dropped in favour of "assume zero".
    const stored: RestartState = { ...emptyState(), callsSpentToday: 45_000 - DEFAULT_DISCOVERY_COST + 1, lastDiscoveryCost: null };
    const repo = new FakeRepo(stored);
    const source = new RestartableSource([pool('MinswapV2', 'a')]);

    const s = await runTick(deps(source, repo, seeded(stored)));

    expect(source.discoverCalls).toBe(0);
    expect(s.errors[0]?.scope).toBe('budget');
  });

  it('a ceiling of 0 disables the check', async () => {
    const stored: RestartState = { ...emptyState(), callsSpentToday: 1_000_000, lastDiscoveryCost: SWEEP_CALLS };
    const repo = new FakeRepo(stored);
    const source = new RestartableSource([pool('MinswapV2', 'a')]);

    const s = await runTick(deps(source, repo, seeded(stored), 0));

    expect(s.discovered).toBe(true);
  });

  it('the spend counter rolls over at UTC midnight instead of carrying yesterday into today', async () => {
    // Without the rollover, the first tick of a new day is refused on yesterday's spend -- which is
    // exactly the tick that most needs to be allowed to discover.
    const stored: RestartState = { ...emptyState(), callsSpentToday: 49_000, lastDiscoveryCost: SWEEP_CALLS };
    const repo = new FakeRepo(stored);
    const source = new RestartableSource([pool('MinswapV2', 'a')]);
    const state: CollectorState = { ...seeded(stored), spendDay: '2026-09-07' };

    const s = await runTick(deps(source, repo, state));

    expect(state.spendDay).toBe('2026-09-08');
    expect(s.discovered).toBe(true);
    // The day's own spend starts from this tick, not from yesterday's total.
    expect(state.callsSpentToday).toBe(SWEEP_CALLS);
  });

  it('the counter accumulates across ticks so a restart-free day is still bounded', async () => {
    const stored: RestartState = { ...emptyState(), pools: [cached('MinswapV2', 'a')], lastDiscoveryAt: NOW, lastDiscoveryCost: SWEEP_CALLS };
    const repo = new FakeRepo(stored);
    const source = new RestartableSource([pool('MinswapV2', 'a')]);
    source.hydrate(stored.pools);
    const state = seeded(stored);

    await runTick(deps(source, repo, state));
    await runTick(deps(source, repo, state));

    expect(state.callsSpentToday).toBe(2 * REFRESH_CALLS_PER_POOL);
  });
});
