import { describe, expect, it } from 'vitest';
import type { Pair } from '@ctb/universe';
import {
  isPoolFailure, runTick,
  type CollectorState, type PoolLike, type PoolSource, type RunError, type RunSummary, type SnapshotRepo, type SnapshotRow, type SourceResult,
} from '../src/index.js';

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

class FakeSource implements PoolSource {
  discoverCalls = 0;
  refreshCalls = 0;
  calls = 0;
  constructor(
    private readonly pools: PoolLike[],
    private readonly tipFails = false,
    private readonly discoverFailures: RunError[] = [],
    private readonly refreshFailures: RunError[] = [],
    private readonly throwOn?: 'discover' | 'refresh',
  ) {}
  async discover(): Promise<SourceResult> {
    this.discoverCalls++;
    this.calls += 10;
    if (this.throwOn === 'discover') throw new Error('boom');
    return { pools: this.pools, failures: this.discoverFailures };
  }
  async refresh(): Promise<SourceResult> {
    this.refreshCalls++;
    this.calls += this.pools.length;
    if (this.throwOn === 'refresh') throw new Error('boom');
    return { pools: this.pools, failures: this.refreshFailures };
  }
  async tip() { if (this.tipFails) throw new Error('blockfrost down'); return { height: 42, time: new Date() }; }
  providerCalls() { return this.calls; }
  resetProviderCalls() { this.calls = 0; }
  knownPoolCount() { return this.discoverCalls === 0 ? 0 : this.pools.length; }
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
const fixedNow = () => new Date('2026-09-05T15:07:41Z');

function deps(source: PoolSource, repo: SnapshotRepo, state: CollectorState = { lastDiscoveryAt: null }) {
  return { source, repo, pairs: [SNEK_PAIR], log, now: fixedNow, intervalSec: 300, rediscoverAfterMs: 24 * 3600 * 1000, state };
}

describe('runTick', () => {
  it('discovers on the first tick, refreshes on the next, writes snapshots at the bucketed tick', async () => {
    const source = new FakeSource([pool('MinswapV2', 'a'), pool('SundaeSwapV3', 'b')]);
    const repo = new FakeRepo();
    const state: CollectorState = { lastDiscoveryAt: null };
    const s1 = await runTick(deps(source, repo, state));
    expect(s1).toMatchObject({ discovered: true, poolsAttempted: 2, poolsWritten: 2, poolsFailed: 0, errors: [] });
    expect(repo.rows[0]?.tickTs).toEqual(new Date('2026-09-05T15:05:00Z'));
    expect(repo.rows[0]?.blockHeight).toBe(42);
    const s2 = await runTick(deps(source, repo, state));
    expect(s2.discovered).toBe(false);
    expect(source.discoverCalls).toBe(1);
    expect(source.refreshCalls).toBe(1);
    expect(s2.providerCalls).toBe(2); // one per pool, counter reset between ticks
  });

  it('records a mapping failure per pool and still writes the others', async () => {
    const source = new FakeSource([pool('MinswapV2', 'a'), pool('FutureSwap', 'z')]);
    const repo = new FakeRepo();
    const s = await runTick(deps(source, repo));
    expect(s.poolsWritten).toBe(1);
    expect(s.poolsFailed).toBe(1);
    expect(s.errors[0]?.scope).toBe('map:FutureSwap:z');
    expect(s.errors[0]?.message).toMatch(/unknown venue/);
  });

  it('finishes the run with an error and no snapshots when the tip cannot be read', async () => {
    const source = new FakeSource([pool('MinswapV2', 'a')], true);
    const repo = new FakeRepo();
    const s = await runTick(deps(source, repo));
    expect(repo.rows).toHaveLength(0);
    expect(repo.summaries).toHaveLength(1);
    expect(s.errors[0]).toEqual({ scope: 'tip', message: 'blockfrost down' });
  });

  it('rediscovers when the last discovery is older than the threshold', async () => {
    const source = new FakeSource([pool('MinswapV2', 'a')]);
    const repo = new FakeRepo();
    const state: CollectorState = { lastDiscoveryAt: new Date('2026-09-04T10:00:00Z') };
    // knownPoolCount() is 0 until discover() ran, so this also covers "process restarted"
    const s = await runTick(deps(source, repo, state));
    expect(s.discovered).toBe(true);
    expect(state.lastDiscoveryAt).toEqual(fixedNow());
  });

  it('counts per-pool discovery failures (both venue-scoped and pool-scoped) toward poolsAttempted/poolsFailed', async () => {
    const discoverFailures: RunError[] = [
      { scope: 'discover:Splash', message: 'venue down' },
      { scope: 'discover:MinswapV2:bad', message: 'no address' },
    ];
    const source = new FakeSource([pool('MinswapV2', 'a'), pool('SundaeSwapV3', 'b')], false, discoverFailures);
    const repo = new FakeRepo();
    const s = await runTick(deps(source, repo));
    expect(s.poolsAttempted).toBe(3);
    expect(s.poolsFailed).toBe(1);
    expect(s.poolsWritten).toBe(2);
    expect(s.errors).toHaveLength(2);
  });

  it('counts per-pool refresh failures toward poolsAttempted/poolsFailed', async () => {
    const refreshFailures: RunError[] = [{ scope: 'refresh:MinswapV2:x', message: 'timeout' }];
    const source = new FakeSource([pool('MinswapV2', 'a')], false, [], refreshFailures);
    const repo = new FakeRepo();
    const state: CollectorState = { lastDiscoveryAt: null };
    await runTick(deps(source, repo, state));
    source.resetProviderCalls();
    const s = await runTick(deps(source, repo, state));
    expect(s.poolsAttempted).toBe(2);
    expect(s.poolsFailed).toBe(1);
  });

  it('never propagates a throw from refresh(); records it on the run row with no snapshots', async () => {
    const source = new FakeSource([pool('MinswapV2', 'a')], false, [], [], 'refresh');
    const repo = new FakeRepo();
    const state: CollectorState = { lastDiscoveryAt: null };
    await runTick(deps(source, repo, state)); // first tick: discover succeeds, seeds known pools
    const rowsBefore = repo.rows.length;
    await expect(runTick(deps(source, repo, state))).resolves.toBeDefined();
    expect(repo.rows.length).toBe(rowsBefore);
    expect(repo.summaries.at(-1)?.errors[0]).toEqual({ scope: 'refresh', message: 'boom' });
    expect(repo.summaries.at(-1)?.discovered).toBe(false);
  });
});

describe('isPoolFailure', () => {
  it('is true for a per-pool refresh failure', () => {
    expect(isPoolFailure({ scope: 'refresh:a', message: 'x' })).toBe(true);
  });
  it('is true for a per-pool discovery failure (venue:identifier)', () => {
    expect(isPoolFailure({ scope: 'discover:Splash:abc', message: 'x' })).toBe(true);
  });
  it('is false for a venue-level discovery failure', () => {
    expect(isPoolFailure({ scope: 'discover:Splash', message: 'x' })).toBe(false);
  });
  it('is false for an unrelated scope', () => {
    expect(isPoolFailure({ scope: 'tip', message: 'x' })).toBe(false);
  });
});
