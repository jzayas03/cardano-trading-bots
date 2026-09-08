import { describe, expect, it } from 'vitest';
import type { Pair } from '@ctb/universe';
import { freshState, runTick, type CollectorState, type PoolLike, type PoolSource, type RunSummary, type SnapshotRepo, type SnapshotRow, type SourceResult } from '../src/pure.js';

const SNEK_PAIR: Pair = {
  base: { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme',
    unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b' },
  quote: 'lovelace',
};
const pool = (dex: string, id: string): PoolLike => ({
  dex, identifier: id, address: `addr_${id}`, assetA: 'lovelace', assetB: { policyId: SNEK_PAIR.base.policyId, nameHex: SNEK_PAIR.base.assetNameHex },
  reserveA: 100n, reserveB: 50n, poolFeePercent: 0.3,
});

/** A source whose discovery loses one venue; `rediscover` returns that venue's pools on the Nth call. */
class LosingSource implements PoolSource {
  rediscoverCalls = 0;
  lost: string[] = ['MinswapV2'];
  constructor(private readonly succeedOnRediscoverCall: number, private readonly rediscoverThrows = false) {}
  async discover(): Promise<SourceResult> { return { pools: [pool('SundaeSwapV3', 's1')], failures: [{ scope: 'discover:MinswapV2', message: 'returned no pools on 4 attempts' }] }; }
  async refresh(): Promise<SourceResult> { return { pools: [pool('SundaeSwapV3', 's1')], failures: [] }; }
  async tip() { return { height: 42, time: new Date() }; }
  providerCalls() { return 0; }
  resetProviderCalls() {}
  knownPoolCount() { return 1; }
  lostVenues() { return this.lost; }
  async rediscover(): Promise<SourceResult> {
    this.rediscoverCalls++;
    if (this.rediscoverThrows) throw new Error('boom');
    if (this.rediscoverCalls >= this.succeedOnRediscoverCall) { this.lost = []; return { pools: [pool('MinswapV2', 'm1')], failures: [] }; }
    return { pools: [], failures: [{ scope: 'discover:MinswapV2', message: 'returned no pools on 4 attempts' }] };
  }
  lastDiscoveryCalls() { return { MinswapV2: this.lost.length ? 4 : 3300 }; }
}

class FakeRepo implements SnapshotRepo {
  rows: SnapshotRow[] = [];
  summaries: RunSummary[] = [];
  nextId = 1;
  async syncTokens() {}
  async startRun() { return this.nextId++; }
  async insertSnapshots(_runId: number, rows: SnapshotRow[]) { this.rows.push(...rows); return rows.length; }
  async finishRun(_runId: number, _at: Date, s: RunSummary) { this.summaries.push(s); }
  async lastRuns() { return []; }
}

const log = { info: () => {}, warn: () => {}, error: () => {} };
const at = (m: number) => () => new Date(Date.UTC(2026, 8, 7, 1, m));
const deps = (source: PoolSource, repo: SnapshotRepo, state: CollectorState, m: number) =>
  ({ source, repo, pairs: [SNEK_PAIR], log, now: at(m), intervalSec: 600, rediscoverAfterMs: 24 * 3600 * 1000, state, dailyCallCeiling: 0 });

describe('runTick retries lost venues on refresh ticks', () => {
  it('a refresh tick calls rediscover while a venue is lost, writes the returning pools with that tick, and carries its per-venue calls; then stops once found', async () => {
    const source = new LosingSource(2);
    const repo = new FakeRepo();
    const state: CollectorState = freshState(at(0)());
    const d0 = await runTick(deps(source, repo, state, 40)); // discovery: loses MinswapV2
    expect(d0.discovered).toBe(true);
    expect(source.rediscoverCalls, 'no rediscovery on the discovery tick itself').toBe(0);
    const r1 = await runTick(deps(source, repo, state, 50)); // refresh + rediscover attempt 1: still lost
    expect(r1.discovered).toBe(false);
    expect(source.rediscoverCalls).toBe(1);
    expect(r1.errors).toEqual([{ scope: 'discover:MinswapV2', message: 'returned no pools on 4 attempts' }]);
    expect(r1.discoveryCalls).toEqual({ MinswapV2: 4 });
    expect(r1.poolsWritten).toBe(1);
    const r2 = await runTick(deps(source, repo, state, 60)); // refresh + rediscover attempt 2: found
    expect(source.rediscoverCalls).toBe(2);
    expect(r2.errors).toEqual([]);
    expect(r2.poolsWritten, 'the refreshed pool plus the returning venue\'s pool, on this tick').toBe(2);
    expect(r2.discoveryCalls).toEqual({ MinswapV2: 3300 });
    expect(repo.rows.filter((r) => r.dex === 'MinswapV2').map((r) => r.tickTs.toISOString())).toEqual(['2026-09-07T02:00:00.000Z']);
    const r3 = await runTick(deps(source, repo, state, 70)); // nothing lost: no rediscovery, no discoveryCalls
    expect(source.rediscoverCalls).toBe(2);
    expect(r3.discoveryCalls).toBeNull();
  });
  it('a throw from rediscover is recorded on the row and the refreshed pools are still written', async () => {
    const source = new LosingSource(1, true);
    const repo = new FakeRepo();
    const state: CollectorState = freshState(at(0)());
    await runTick(deps(source, repo, state, 40));
    const r = await runTick(deps(source, repo, state, 50));
    expect(r.errors).toEqual([{ scope: 'rediscover', message: 'boom' }]);
    expect(r.poolsWritten).toBe(1);
  });
});
