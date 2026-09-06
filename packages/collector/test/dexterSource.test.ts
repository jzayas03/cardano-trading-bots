import { describe, expect, it } from 'vitest';
import type { Pair } from '@ctb/universe';
import { DexterPoolSource, type DexName, type Logger, type LiquidityPoolShape, type PoolFetcher } from '../src/index.js';

const PAIR: Pair = {
  base: {
    ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b',
    decimals: 0, category: 'Meme', unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b',
  },
  quote: 'lovelace',
};

function shape(dex: DexName, id: string, address: string, reserveA = 100n): LiquidityPoolShape {
  return {
    dex, identifier: id, address,
    assetA: 'lovelace',
    assetB: { policyId: PAIR.base.policyId, nameHex: PAIR.base.assetNameHex, decimals: PAIR.base.decimals },
    reserveA, reserveB: 50n, poolFeePercent: 0.3,
  };
}

/** Fake seam for DexterPoolSource so these tests never touch the network. */
class FakeFetcher implements PoolFetcher {
  discoverCalls: DexName[] = [];
  poolStateCalls: LiquidityPoolShape[] = [];
  readonly stateFor = new Map<string, LiquidityPoolShape | undefined | Error | string>();
  constructor(private readonly byVenue: Record<string, LiquidityPoolShape[] | Error> = {}) {}

  async discoverVenue(venue: DexName): Promise<LiquidityPoolShape[]> {
    this.discoverCalls.push(venue);
    const result = this.byVenue[venue];
    if (result instanceof Error) throw result;
    return result ?? [];
  }

  async poolState(pool: LiquidityPoolShape): Promise<LiquidityPoolShape | undefined> {
    this.poolStateCalls.push(pool);
    const key = `${pool.dex}:${pool.identifier}`;
    const result = this.stateFor.get(key);
    if (result instanceof Error) throw result;
    if (typeof result === 'string') throw result; // Dexter itself rejects with plain strings sometimes.
    return result;
  }
}

function makeLog(): { log: Logger; warns: unknown[] } {
  const warns: unknown[] = [];
  return { log: { info: () => {}, warn: (obj) => { warns.push(obj); }, error: () => {} }, warns };
}

describe('DexterPoolSource.discover', () => {
  it('records a venue-level failure and warns when a venue returns no pools', async () => {
    const { log, warns } = makeLog();
    const fetcher = new FakeFetcher({ MinswapV2: [] });
    const source = new DexterPoolSource({ blockfrostProjectId: 'unit-test', log, venues: ['MinswapV2'], fetcher });

    const result = await source.discover([PAIR]);

    expect(result.pools).toEqual([]);
    expect(result.failures).toEqual([
      { scope: 'discover:MinswapV2', message: expect.stringContaining('returned no pools') },
    ]);
    expect(warns.length).toBeGreaterThan(0);
  });

  it('records a venue-level failure when the venue fetch throws', async () => {
    const { log } = makeLog();
    const fetcher = new FakeFetcher({ MinswapV2: new Error('on-chain boom') });
    const source = new DexterPoolSource({ blockfrostProjectId: 'unit-test', log, venues: ['MinswapV2'], fetcher });

    const result = await source.discover([PAIR]);

    expect(result.pools).toEqual([]);
    expect(result.failures).toEqual([{ scope: 'discover:MinswapV2', message: 'on-chain boom' }]);
  });

  it('keeps good pools and records a per-pool failure for a malformed pool in the same venue', async () => {
    const { log } = makeLog();
    const good = shape('MinswapV2', 'good', 'addr_good');
    const bad = shape('MinswapV2', 'bad', '');
    const fetcher = new FakeFetcher({ MinswapV2: [good, bad] });
    const source = new DexterPoolSource({ blockfrostProjectId: 'unit-test', log, venues: ['MinswapV2'], fetcher });

    const result = await source.discover([PAIR]);

    expect(result.pools.map((p) => p.identifier)).toEqual(['good']);
    expect(result.failures).toEqual([
      { scope: 'discover:MinswapV2:bad', message: expect.stringContaining('no address') },
    ]);
  });
});

describe('DexterPoolSource.refresh', () => {
  it('isolates a per-pool refresh failure when the pool state comes back malformed, and still returns the others', async () => {
    const { log } = makeLog();
    const good = shape('MinswapV2', 'good', 'addr_good');
    const bad = shape('MinswapV2', 'bad', 'addr_bad');
    const fetcher = new FakeFetcher({ MinswapV2: [good, bad] });
    const source = new DexterPoolSource({ blockfrostProjectId: 'unit-test', log, venues: ['MinswapV2'], fetcher });
    await source.discover([PAIR]);

    fetcher.stateFor.set('MinswapV2:good', shape('MinswapV2', 'good', 'addr_good2'));
    fetcher.stateFor.set('MinswapV2:bad', shape('MinswapV2', 'bad', '')); // malformed on refresh

    const result = await source.refresh();

    expect(result.pools.map((p) => p.identifier)).toEqual(['good']);
    expect(result.failures).toEqual([
      { scope: 'refresh:MinswapV2:bad', message: expect.stringContaining('no address') },
    ]);
  });

  it('records a refresh failure for a rejected pool state, including a plain string rejection', async () => {
    const { log } = makeLog();
    const good = shape('MinswapV2', 'good', 'addr_good');
    const bad = shape('MinswapV2', 'bad', 'addr_bad');
    const fetcher = new FakeFetcher({ MinswapV2: [good, bad] });
    const source = new DexterPoolSource({ blockfrostProjectId: 'unit-test', log, venues: ['MinswapV2'], fetcher });
    await source.discover([PAIR]);

    fetcher.stateFor.set('MinswapV2:good', shape('MinswapV2', 'good', 'addr_good2'));
    fetcher.stateFor.set('MinswapV2:bad', 'blockfrost 502'); // plain string rejection

    const result = await source.refresh();

    expect(result.pools.map((p) => p.identifier)).toEqual(['good']);
    expect(result.failures).toEqual([{ scope: 'refresh:MinswapV2:bad', message: 'blockfrost 502' }]);
  });

  it('tracks knownPoolCount via discover and updates known state via a successful refresh', async () => {
    const { log } = makeLog();
    const good = shape('MinswapV2', 'good', 'addr_good');
    const fetcher = new FakeFetcher({ MinswapV2: [good] });
    const source = new DexterPoolSource({ blockfrostProjectId: 'unit-test', log, venues: ['MinswapV2'], fetcher });

    expect(source.knownPoolCount()).toBe(0);
    await source.discover([PAIR]);
    expect(source.knownPoolCount()).toBe(1);

    fetcher.stateFor.set('MinswapV2:good', shape('MinswapV2', 'good', 'addr_good_updated'));
    const result = await source.refresh();

    expect(result.pools[0]?.address).toBe('addr_good_updated');
    expect(source.knownPoolCount()).toBe(1);
  });
});

describe('DexterPoolSource.tip', () => {
  it('surfaces a clear timeout message when blockfrost does not respond in time', async () => {
    const { log } = makeLog();
    const timeoutFetch = (async () => {
      throw new DOMException('The operation was aborted.', 'TimeoutError');
    }) as unknown as typeof fetch;
    const source = new DexterPoolSource({
      blockfrostProjectId: 'unit-test', log, fetch: timeoutFetch, fetcher: new FakeFetcher(),
    });

    await expect(source.tip()).rejects.toThrow('blockfrost /blocks/latest timed out after 10000 ms');
  });

  it('passes an AbortSignal with a 10s budget to fetch', async () => {
    const { log } = makeLog();
    let capturedSignal: AbortSignal | undefined;
    const captureFetch = (async (_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ height: 123, time: 1000 }), { status: 200 });
    }) as unknown as typeof fetch;
    const source = new DexterPoolSource({
      blockfrostProjectId: 'unit-test', log, fetch: captureFetch, fetcher: new FakeFetcher(),
    });

    const tip = await source.tip();

    expect(tip.height).toBe(123);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});
