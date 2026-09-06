import { describe, expect, it } from 'vitest';
import { DexterPoolSource } from '../src/index.js';

const LIVE = process.env.RUN_LIVE_TESTS === '1' && !!process.env.BLOCKFROST_PROJECT_ID;
const log = { info: () => {}, warn: () => {}, error: () => {} };

// NIGHT has a SundaeSwapV3 ADA pool (about 481k ADA TVL on 2026-09-06). SNEK does not: its only
// SundaeSwapV3 pool is NIGHT/SNEK, so an ADA-pair discovery there must come back empty and be
// reported as a venue-level failure, never as a silent zero. (The SNEK/ADA pool Plan 1 recorded for
// this venue came from Dexter's DEX-API path, which is stale relative to the chain.)
const NIGHT = {
  base: { ticker: 'NIGHT', policyId: '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa', assetNameHex: '4e49474854', decimals: 6, category: 'Privacy',
    unit: '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa4e49474854' },
  quote: 'lovelace' as const,
};
const SNEK = {
  base: { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme',
    unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b' },
  quote: 'lovelace' as const,
};

function makeSource(): DexterPoolSource {
  return new DexterPoolSource({ blockfrostProjectId: process.env.BLOCKFROST_PROJECT_ID as string, log, venues: ['SundaeSwapV3'] });
}

describe.skipIf(!LIVE)('DexterPoolSource (live Blockfrost)', () => {
  it('discovers and refreshes NIGHT/ADA on SundaeSwapV3, reporting provider calls', async () => {
    const source = makeSource();
    const tip = await source.tip();
    expect(tip.height).toBeGreaterThan(10_000_000);

    const d = await source.discover([NIGHT]);
    expect(d.failures).toEqual([]);
    expect(d.pools.length).toBeGreaterThanOrEqual(1);
    const discoverCalls = source.providerCalls();
    expect(d.pools[0]?.reserveA).toBeGreaterThan(0n);

    source.resetProviderCalls();
    const r = await source.refresh();
    expect(r.failures).toEqual([]);
    expect(r.pools.length).toBe(d.pools.length);
    const refreshCalls = source.providerCalls();
    // Record these numbers in the M1 report; they size the tick budget. Refresh cost per pool depends on the
    // venue's address layout: SundaeSwapV3 keeps every pool at one address, so refreshing one NIGHT pool
    // re-reads every NIGHT-holding UTxO there (about 10 calls per pool on 2026-09-06). The only invariant
    // worth asserting is that a refresh is cheaper than a full discovery.
    console.log(`SundaeSwapV3 NIGHT: discover=${discoverCalls} calls, refresh=${refreshCalls} calls for ${r.pools.length} pools (${(refreshCalls / r.pools.length).toFixed(1)} per pool)`);
    expect(refreshCalls).toBeGreaterThanOrEqual(r.pools.length);
    expect(refreshCalls).toBeLessThan(discoverCalls);
  }, 180_000);

  it('reports a venue with no ADA pool for the token as one counted failure, not a silent zero', async () => {
    const source = makeSource();
    const d = await source.discover([SNEK]);
    expect(d.pools).toEqual([]);
    expect(d.failures).toHaveLength(1);
    expect(d.failures[0]?.scope).toBe('discover:SundaeSwapV3');
    expect(d.failures[0]?.message).toMatch(/returned no pools/);
  }, 180_000);
});
