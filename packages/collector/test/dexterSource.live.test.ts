import { describe, expect, it } from 'vitest';
import { DexterPoolSource } from '../src/index.js';

const LIVE = process.env.RUN_LIVE_TESTS === '1' && !!process.env.BLOCKFROST_PROJECT_ID;
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!LIVE)('DexterPoolSource (live Blockfrost)', () => {
  it('discovers and refreshes SNEK/ADA on SundaeSwapV3, reporting provider calls', async () => {
    const source = new DexterPoolSource({
      blockfrostProjectId: process.env.BLOCKFROST_PROJECT_ID as string,
      log,
      venues: ['SundaeSwapV3'],
    });
    const pair = {
      base: { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme',
        unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b' },
      quote: 'lovelace' as const,
    };
    const tip = await source.tip();
    expect(tip.height).toBeGreaterThan(10_000_000);

    const d = await source.discover([pair]);
    expect(d.failures).toEqual([]);
    expect(d.pools.length).toBeGreaterThanOrEqual(1);
    const discoverCalls = source.providerCalls();
    expect(d.pools[0]?.reserveA).toBeGreaterThan(0n);

    source.resetProviderCalls();
    const r = await source.refresh();
    expect(r.failures).toEqual([]);
    expect(r.pools.length).toBe(d.pools.length);
    const refreshCalls = source.providerCalls();
    // Record these two numbers in the M1 report; they size the tick budget.
    console.log(`SundaeSwapV3 SNEK: discover=${discoverCalls} calls, refresh=${refreshCalls} calls for ${r.pools.length} pools`);
    expect(refreshCalls).toBeLessThanOrEqual(2 * r.pools.length);
  }, 120_000);
});
