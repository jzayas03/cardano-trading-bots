import { describe, expect, it } from 'vitest';
import { bucketTick, poolIdOf, poolToSnapshot, type PoolLike } from '../src/index.js';

const SNEK = { policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', nameHex: '534e454b' };
const ctx = { tickTs: new Date('2026-09-05T15:00:00Z'), blockHeight: 12_345_678, observedAt: new Date('2026-09-05T15:00:07Z') };

// Live SundaeSwapV3 SNEK/ADA pool captured 2026-09-05.
const sundaeV3: PoolLike = {
  dex: 'SundaeSwapV3',
  identifier: 'cacb7fd5f5b84bf8',
  address: 'addr1_sundae_pool',
  assetA: 'lovelace',
  assetB: SNEK,
  reserveA: 52_331_970_594n,
  reserveB: 23_779_491n,
  poolFeePercent: 1,
};

describe('poolToSnapshot', () => {
  it('orients ADA as quote and the token as base', () => {
    const row = poolToSnapshot(sundaeV3, ctx);
    expect(row.poolId).toBe('SundaeSwapV3:cacb7fd5f5b84bf8');
    expect(row.baseUnit).toBe(SNEK.policyId + SNEK.nameHex);
    expect(row.quoteUnit).toBe('lovelace');
    expect(row.reserveBase).toBe(23_779_491n);
    expect(row.reserveQuote).toBe(52_331_970_594n);
    expect(row.feeBps).toBe(100);
    expect(row.poolType).toBe('cpmm');
    expect(row.tvlLovelace).toBe(2n * 52_331_970_594n);
    expect(row.blockHeight).toBe(12_345_678);
    expect(row.tickTs).toEqual(ctx.tickTs);
  });

  it('handles the flipped orientation (token as assetA)', () => {
    const flipped: PoolLike = { ...sundaeV3, assetA: SNEK, assetB: 'lovelace', reserveA: 23_779_491n, reserveB: 52_331_970_594n };
    const row = poolToSnapshot(flipped, ctx);
    expect(row.reserveBase).toBe(23_779_491n);
    expect(row.reserveQuote).toBe(52_331_970_594n);
  });

  it('rounds fractional fee percent to basis points', () => {
    expect(poolToSnapshot({ ...sundaeV3, poolFeePercent: 0.3 }, ctx).feeBps).toBe(30);
    expect(poolToSnapshot({ ...sundaeV3, poolFeePercent: 0.05 }, ctx).feeBps).toBe(5);
  });

  it('fails closed on an unknown venue', () => {
    expect(() => poolToSnapshot({ ...sundaeV3, dex: 'FutureSwap' }, ctx)).toThrow(/unknown venue FutureSwap/);
  });

  it('fails closed on a pool with no ADA side', () => {
    const usdm = { policyId: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad', nameHex: '0014df105553444d' };
    expect(() => poolToSnapshot({ ...sundaeV3, assetA: usdm }, ctx)).toThrow(/not an ADA pair/);
  });

  it('fails closed on an impossible fee', () => {
    expect(() => poolToSnapshot({ ...sundaeV3, poolFeePercent: 150 }, ctx)).toThrow(/fee/);
    expect(() => poolToSnapshot({ ...sundaeV3, poolFeePercent: -1 }, ctx)).toThrow(/fee/);
  });
});

describe('bucketTick', () => {
  it('floors to the interval boundary', () => {
    expect(bucketTick(new Date('2026-09-05T15:07:41Z'), 300)).toEqual(new Date('2026-09-05T15:05:00Z'));
    expect(bucketTick(new Date('2026-09-05T15:05:00Z'), 300)).toEqual(new Date('2026-09-05T15:05:00Z'));
  });
});

describe('poolIdOf', () => {
  it('joins dex and identifier', () => {
    expect(poolIdOf({ dex: 'MinswapV2', identifier: 'abc' })).toBe('MinswapV2:abc');
  });
});
