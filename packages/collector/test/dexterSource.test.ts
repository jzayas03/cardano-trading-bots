import { describe, expect, it } from 'vitest';
import { Asset } from '@indigo-labs/dexter';
import type { Pair } from '@ctb/universe';
import {
  DefaultPoolFetcher, DexterPoolSource,
  type DexName, type FetcherAsset, type Logger, type LiquidityPoolShape, type PoolFetcher, type PoolStateClient,
  type SplashDiscoveryClient,
} from '../src/index.js';

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
      sleep: async () => {},
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

  it('retries a transient 503 once and succeeds, without waiting on a real timer', async () => {
    const { log } = makeLog();
    let calls = 0;
    const flakyFetch = (async () => {
      calls++;
      if (calls === 1) return new Response('', { status: 503 });
      return new Response(JSON.stringify({ height: 456, time: 2000 }), { status: 200 });
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    const source = new DexterPoolSource({
      blockfrostProjectId: 'unit-test', log, fetch: flakyFetch, fetcher: new FakeFetcher(),
      sleep: async (ms) => { slept.push(ms); },
    });

    const tip = await source.tip();

    expect(tip.height).toBe(456);
    expect(calls).toBe(2);
    expect(slept.length).toBe(1);
  });
});

describe('DefaultPoolFetcher.poolState', () => {
  const pool = shape('MinswapV2', 'good', 'addr_good');

  it('retries a transient rejection once and succeeds, without waiting on a real timer', async () => {
    const { log, warns } = makeLog();
    const slept: number[] = [];
    let calls = 0;
    const poolStateClient: PoolStateClient = {
      getLiquidityPoolState: async () => {
        calls++;
        if (calls === 1) throw new Error('Request failed with status code 503');
        return pool;
      },
    };
    const fetcher = new DefaultPoolFetcher({
      url: 'https://example.invalid', projectId: 'unit-test', log, retryBudgetMs: 60_000,
      poolStateClient, sleep: async (ms) => { slept.push(ms); },
    });

    const result = await fetcher.poolState(pool);

    expect(result).toEqual(pool);
    expect(calls).toBe(2);
    expect(slept.length).toBe(1);
    expect(warns.length).toBe(1);
  });

  it('does not retry a non-transient rejection', async () => {
    const { log, warns } = makeLog();
    const slept: number[] = [];
    let calls = 0;
    const poolStateClient: PoolStateClient = {
      getLiquidityPoolState: async () => { calls++; throw new Error('Request failed with status code 403'); },
    };
    const fetcher = new DefaultPoolFetcher({
      url: 'https://example.invalid', projectId: 'unit-test', log, retryBudgetMs: 60_000,
      poolStateClient, sleep: async (ms) => { slept.push(ms); },
    });

    await expect(fetcher.poolState(pool)).rejects.toThrow(/403/);
    expect(calls).toBe(1);
    expect(slept.length).toBe(0);
    expect(warns.length).toBe(0);
  });

  it('gives up after 4 attempts on a persistent 503', async () => {
    const { log } = makeLog();
    const slept: number[] = [];
    let calls = 0;
    const poolStateClient: PoolStateClient = {
      getLiquidityPoolState: async () => { calls++; throw new Error('Request failed with status code 503'); },
    };
    const fetcher = new DefaultPoolFetcher({
      url: 'https://example.invalid', projectId: 'unit-test', log, retryBudgetMs: 60_000,
      poolStateClient, sleep: async (ms) => { slept.push(ms); },
    });

    await expect(fetcher.poolState(pool)).rejects.toThrow(/after 4 attempts/);
    expect(calls).toBe(4);
    expect(slept.length).toBe(3);
  });
});

describe('DefaultPoolFetcher bounded Splash discovery', () => {
  const TOKEN1 = { policyId: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', nameHex: '544f4b454e31' };
  const TOKEN2 = { policyId: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222', nameHex: '544f4b454e32' };
  const OTHER_TOKEN = { policyId: 'cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333', nameHex: '544f4b454e33' };
  const tokenPairs: Array<['lovelace', Asset]> = [
    ['lovelace', new Asset(TOKEN1.policyId, TOKEN1.nameHex, 0)],
    ['lovelace', new Asset(TOKEN2.policyId, TOKEN2.nameHex, 0)],
  ];
  const PAIR1: Pair = {
    base: { ticker: 'T1', policyId: TOKEN1.policyId, assetNameHex: TOKEN1.nameHex, decimals: 0, category: 'Meme', unit: `${TOKEN1.policyId}${TOKEN1.nameHex}` },
    quote: 'lovelace',
  };

  function splashPool(id: string, address: string, token: { policyId: string; nameHex: string }): LiquidityPoolShape {
    return {
      dex: 'Splash', identifier: id, address,
      assetA: 'lovelace', assetB: { policyId: token.policyId, nameHex: token.nameHex, decimals: 0 },
      reserveA: 100n, reserveB: 50n, poolFeePercent: 0.3,
    };
  }

  /** Fake seam so these tests never touch Dexter or the network. Keys utxo results by
   *  `address:policyId+nameHex`, matching how `discoverBounded` queries one address/token at a time. */
  class FakeSplashClient implements SplashDiscoveryClient {
    utxoCalls: Array<{ address: string; asset: FetcherAsset }> = [];
    constructor(
      private readonly addressList: string[],
      private readonly utxosFor: Map<string, unknown[] | Error>,
      private readonly poolForUtxo: Map<unknown, LiquidityPoolShape | undefined>,
    ) {}

    async addresses(): Promise<string[]> { return this.addressList; }

    async utxos(address: string, asset: FetcherAsset): Promise<unknown[]> {
      this.utxoCalls.push({ address, asset });
      const result = this.utxosFor.get(`${address}:${asset.policyId}${asset.nameHex}`);
      if (result instanceof Error) throw result;
      return result ?? [];
    }

    async poolFromUtxo(utxo: unknown): Promise<LiquidityPoolShape | undefined> { return this.poolForUtxo.get(utxo); }
  }

  it('queries every address x token, dedupes by identifier, and drops non-matching pools', async () => {
    const { log } = makeLog();
    const utxoA1 = { id: 'addr1-token1' };
    const utxoA2 = { id: 'addr1-token2' };
    const utxoB1 = { id: 'addr2-token1-dup' }; // resolves to the same pool identifier as utxoA1
    const utxoB2 = { id: 'addr2-token2-mismatch' }; // resolves to a pool for a token not in tokenPairs

    const poolForUtxo = new Map<unknown, LiquidityPoolShape | undefined>([
      [utxoA1, splashPool('pool-1', 'addr1', TOKEN1)],
      [utxoA2, splashPool('pool-2', 'addr1', TOKEN2)],
      [utxoB1, splashPool('pool-1', 'addr2', TOKEN1)],
      [utxoB2, splashPool('pool-mismatch', 'addr2', OTHER_TOKEN)],
    ]);
    const utxosFor = new Map<string, unknown[]>([
      [`addr1:${TOKEN1.policyId}${TOKEN1.nameHex}`, [utxoA1]],
      [`addr1:${TOKEN2.policyId}${TOKEN2.nameHex}`, [utxoA2]],
      [`addr2:${TOKEN1.policyId}${TOKEN1.nameHex}`, [utxoB1]],
      [`addr2:${TOKEN2.policyId}${TOKEN2.nameHex}`, [utxoB2]],
    ]);
    const splashClient = new FakeSplashClient(['addr1', 'addr2'], utxosFor, poolForUtxo);
    const fetcher = new DefaultPoolFetcher({
      url: 'https://example.invalid', projectId: 'unit-test', log, retryBudgetMs: 60_000, splashClient,
    });

    const pools = await fetcher.discoverVenue('Splash', tokenPairs);

    // 2 addresses x 2 tokens = 4 asset-filtered utxos calls, never one unfiltered scan.
    expect(splashClient.utxoCalls.length).toBe(4);
    expect(pools.map((p) => p.identifier).sort()).toEqual(['pool-1', 'pool-2']);
  });

  it('surfaces a failed address/token query as one discover:Splash RunError while keeping pools found elsewhere', async () => {
    const { log } = makeLog();
    const goodUtxo = { id: 'good-utxo' };
    const goodPool = splashPool('good-pool', 'addr1', TOKEN1);
    const splashClient: SplashDiscoveryClient = {
      addresses: async () => ['addr1', 'addr2'],
      utxos: async (address) => {
        if (address === 'addr1') return [goodUtxo];
        throw new Error('blockfrost 502');
      },
      poolFromUtxo: async (utxo) => (utxo === goodUtxo ? goodPool : undefined),
    };
    const fetcher = new DefaultPoolFetcher({
      url: 'https://example.invalid', projectId: 'unit-test', log, retryBudgetMs: 60_000, splashClient,
    });
    const source = new DexterPoolSource({ blockfrostProjectId: 'unit-test', log, venues: ['Splash'], fetcher });

    const result = await source.discover([PAIR1]);

    expect(result.pools.map((p) => p.identifier)).toEqual(['good-pool']);
    // 2 addresses x 1 token = 1 succeeding + 1 failing query; the failure is reported once, by scope,
    // not once per failed call, and does not also trip the "returned no pools" failure since a pool
    // was found.
    expect(result.failures).toEqual([{ scope: 'discover:Splash', message: '1 address/token queries failed' }]);
  });
});
