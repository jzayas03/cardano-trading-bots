import { describe, expect, it } from 'vitest';
import type { Pair } from '@ctb/universe';
import { DexterPoolSource, type DexName, type LiquidityPoolShape, type Logger, type PoolFetcher } from '../src/index.js';

const PAIR: Pair = {
  base: { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme',
    unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b' },
  quote: 'lovelace',
};
const shape = (dex: DexName, id: string, reserveA = 100n): LiquidityPoolShape => ({
  dex, identifier: id, address: `addr-${id}`, assetA: 'lovelace',
  assetB: { policyId: PAIR.base.policyId, nameHex: PAIR.base.assetNameHex, decimals: 0 }, reserveA, reserveB: 50n, poolFeePercent: 0.3,
});

/** Answers each discoverVenue call for a venue from a queue: [] (Dexter-swallowed error), pools, or an Error to throw. The last entry repeats. */
class SequencedFetcher implements PoolFetcher {
  calls: Record<string, number> = {};
  constructor(private readonly script: Record<string, Array<LiquidityPoolShape[] | Error>>) {}
  async discoverVenue(venue: DexName): Promise<LiquidityPoolShape[]> {
    const n = (this.calls[venue] = (this.calls[venue] ?? 0) + 1);
    const q = this.script[venue] ?? [[]];
    const r = q[Math.min(n, q.length) - 1]!;
    if (r instanceof Error) throw r;
    return r;
  }
  async poolState(pool: LiquidityPoolShape): Promise<LiquidityPoolShape | undefined> { return pool; }
}

function harness(script: Record<string, Array<LiquidityPoolShape[] | Error>>, venues: DexName[], delays = [15_000, 30_000, 60_000], policy: 'deepest' | 'all' = 'all', minDepthLovelace = 0n) {
  const slept: number[] = [];
  const warns: Array<Record<string, unknown>> = [];
  const log: Logger = { info: () => {}, warn: (o) => { warns.push(o as Record<string, unknown>); }, error: () => {} };
  const fetcher = new SequencedFetcher(script);
  const source = new DexterPoolSource({ blockfrostProjectId: 'unit-test', log, venues, fetcher, discoveryRetryDelaysMs: delays, sleep: async (ms) => { slept.push(ms); }, refreshPolicy: policy, minDepthLovelace });
  return { source, fetcher, slept, warns };
}

describe('DexterPoolSource discovery retry (the MinswapV2 504 of 2026-09-07)', () => {
  it('retries a venue that returned no pools, with the configured waits, and succeeds on the third attempt with no failure recorded', async () => {
    const { source, fetcher, slept } = harness({ MinswapV2: [[], [], [shape('MinswapV2', 'p1')]] }, ['MinswapV2']);
    const r = await source.discover([PAIR]);
    expect(r.pools.map((p) => p.identifier)).toEqual(['p1']);
    expect(r.failures).toEqual([]);
    expect(fetcher.calls.MinswapV2).toBe(3);
    expect(slept).toEqual([15_000, 30_000]);
    expect(source.lostVenues()).toEqual([]);
  });
  it('gives up after delays.length + 1 attempts, records ONE venue failure naming the attempt count, and marks the venue lost', async () => {
    const { source, fetcher, slept } = harness({ MinswapV2: [[]] }, ['MinswapV2']);
    const r = await source.discover([PAIR]);
    expect(r.failures).toEqual([{ scope: 'discover:MinswapV2', message: expect.stringContaining('returned no pools on 4 attempts') }]);
    expect(fetcher.calls.MinswapV2).toBe(4);
    expect(slept).toEqual([15_000, 30_000, 60_000]);
    expect(source.lostVenues()).toEqual(['MinswapV2']);
  });
  it('retries a transient throw (a 504 in the message) but not a non-transient one', async () => {
    const t = harness({ MinswapV2: [new Error('Request failed with status code 504'), [shape('MinswapV2', 'p1')]] }, ['MinswapV2']);
    expect((await t.source.discover([PAIR])).failures).toEqual([]);
    expect(t.fetcher.calls.MinswapV2).toBe(2);
    const n = harness({ MinswapV2: [new Error('bad datum'), [shape('MinswapV2', 'p1')]] }, ['MinswapV2']);
    expect((await n.source.discover([PAIR])).failures).toEqual([{ scope: 'discover:MinswapV2', message: 'bad datum' }]);
    expect(n.fetcher.calls.MinswapV2).toBe(1);
    expect(n.source.lostVenues()).toEqual(['MinswapV2']);
  });
  it('a lost venue does not stop the other venues from being discovered in the same pass', async () => {
    const { source } = harness({ MinswapV2: [[]], SundaeSwapV3: [[shape('SundaeSwapV3', 's1')]] }, ['MinswapV2', 'SundaeSwapV3'], []);
    const r = await source.discover([PAIR]);
    expect(r.pools.map((p) => p.identifier)).toEqual(['s1']);
    expect(source.lostVenues()).toEqual(['MinswapV2']);
  });
});

describe('DexterPoolSource.rediscover', () => {
  it('is a no-op with nothing lost', async () => {
    const { source, fetcher } = harness({ MinswapV2: [[shape('MinswapV2', 'p1')]] }, ['MinswapV2']);
    await source.discover([PAIR]);
    expect(await source.rediscover([PAIR])).toEqual({ pools: [], failures: [] });
    expect(fetcher.calls.MinswapV2).toBe(1);
  });
  it('tries only the lost venue, adds its pools to the known set, re-prunes to deepest, and clears the loss', async () => {
    // discovery: MinswapV2 lost (4 empty answers), SundaeSwapV3 found a 100-ADA pool. Rediscovery: MinswapV2 answers with a 900-ADA pool.
    const { source, fetcher } = harness(
      { MinswapV2: [[], [], [], [], [shape('MinswapV2', 'deep', 900n)]], SundaeSwapV3: [[shape('SundaeSwapV3', 'shallow', 100n)]] },
      ['MinswapV2', 'SundaeSwapV3'], [1, 1, 1], 'deepest',
    );
    await source.discover([PAIR]);
    expect(source.lostVenues()).toEqual(['MinswapV2']);
    expect(source.knownPoolCount()).toBe(1);
    const again = await source.rediscover([PAIR]);
    expect(again.pools.map((p) => p.identifier)).toEqual(['deep']);
    expect(again.failures).toEqual([]);
    expect(fetcher.calls.SundaeSwapV3, 'the found venue is not scanned again').toBe(1);
    expect(source.lostVenues()).toEqual([]);
    expect(source.knownPoolCount(), 'deepest per token: the returning 900-ADA pool displaces the 100-ADA one').toBe(1);
    expect((await source.refresh()).pools.map((p) => p.identifier)).toEqual(['deep']);
    expect(source.lastDiscoveryCalls()).toEqual({ MinswapV2: 0 }); // the fake provider counts no real calls; the key set is what matters
  });
  it('keeps the venue lost and records a failure when rediscovery fails again', async () => {
    const { source } = harness({ MinswapV2: [[]] }, ['MinswapV2'], [1]);
    await source.discover([PAIR]);
    const again = await source.rediscover([PAIR]);
    expect(again.failures).toEqual([{ scope: 'discover:MinswapV2', message: expect.stringContaining('returned no pools on 2 attempts') }]);
    expect(source.lostVenues()).toEqual(['MinswapV2']);
  });
});

/**
 * Refresh costs ~14.9 Blockfrost calls per pool per tick (measured over the M1 run, 2026-09-07), so
 * 20 tokens at a 600-second interval is ~42,800 calls a day — 97% of the free tier once a discovery
 * is added, and a single restart pushes it over. Liquidity across the seeded universe spans six
 * orders of magnitude and the shallow end barely moves, so an operator can buy budget back by
 * refreshing only pools above a depth floor. Discovery is untouched, so a token that gains liquidity
 * rejoins on its own.
 */
describe('DexterPoolSource minDepthLovelace', () => {
  const deep = (id: string, ada: bigint): LiquidityPoolShape => shape('MinswapV2', id, ada * 1_000_000n);

  it('keeps a pool at exactly the floor and drops one a lovelace below it', async () => {
    const above = harness({ MinswapV2: [[deep('at-floor', 400_000n)]] }, ['MinswapV2'], [], 'deepest', 400_000_000_000n);
    await above.source.discover([PAIR]);
    expect(above.source.knownPoolCount(), 'exactly at the floor stays').toBe(1);

    const below = harness({ MinswapV2: [[shape('MinswapV2', 'under', 400_000_000_000n - 1n)]] }, ['MinswapV2'], [], 'deepest', 400_000_000_000n);
    await below.source.discover([PAIR]);
    expect(below.source.knownPoolCount(), 'one lovelace below is dropped').toBe(0);
  });

  it('is off by default: every pool survives when no floor is set', async () => {
    const { source } = harness({ MinswapV2: [[shape('MinswapV2', 'dust', 1n)]] }, ['MinswapV2'], [], 'deepest');
    await source.discover([PAIR]);
    expect(source.knownPoolCount()).toBe(1);
  });

  it('leaves DISCOVERY untouched — every pool found is still returned for the snapshot', async () => {
    const { source } = harness({ MinswapV2: [[shape('MinswapV2', 'dust', 1n)]] }, ['MinswapV2'], [], 'deepest', 400_000_000_000n);
    const r = await source.discover([PAIR]);
    expect(r.pools.map((p) => p.identifier), 'the discovery tick still writes it').toEqual(['dust']);
    expect(source.knownPoolCount(), 'but it is not refreshed afterwards').toBe(0);
  });
});
