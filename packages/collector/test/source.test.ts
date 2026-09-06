import { describe, expect, it } from 'vitest';
import { collectPoolShapes, toPoolLike, type LiquidityPoolShape } from '../src/poolShape.js';

describe('toPoolLike', () => {
  it('maps a Dexter pool with an Asset side', () => {
    const shape: LiquidityPoolShape = {
      dex: 'MinswapV2',
      identifier: 'lp1',
      address: 'addr1_min',
      assetA: 'lovelace',
      assetB: { policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', nameHex: '534e454b', decimals: 0 },
      reserveA: 10n,
      reserveB: 20n,
      poolFeePercent: 0.3,
    };
    expect(toPoolLike(shape)).toEqual({
      dex: 'MinswapV2',
      identifier: 'lp1',
      address: 'addr1_min',
      assetA: 'lovelace',
      assetB: { policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', nameHex: '534e454b' },
      reserveA: 10n,
      reserveB: 20n,
      poolFeePercent: 0.3,
    });
  });

  it('rejects a pool with no address (cannot be refreshed later)', () => {
    const shape: LiquidityPoolShape = {
      dex: 'Splash', identifier: 'x', address: '', assetA: 'lovelace',
      assetB: { policyId: 'a'.repeat(56), nameHex: '00', decimals: 0 }, reserveA: 1n, reserveB: 1n, poolFeePercent: 0,
    };
    expect(() => toPoolLike(shape)).toThrow(/no address/);
  });
});

describe('collectPoolShapes', () => {
  it('isolates a malformed pool instead of dropping the rest of the venue list', () => {
    const good1: LiquidityPoolShape = {
      dex: 'Splash', identifier: 'good-1', address: 'addr1_good1', assetA: 'lovelace',
      assetB: { policyId: 'a'.repeat(56), nameHex: '00', decimals: 0 }, reserveA: 1n, reserveB: 1n, poolFeePercent: 0.3,
    };
    const badNoAddress: LiquidityPoolShape = {
      dex: 'Splash', identifier: 'bad-no-address', address: '', assetA: 'lovelace',
      assetB: { policyId: 'a'.repeat(56), nameHex: '00', decimals: 0 }, reserveA: 1n, reserveB: 1n, poolFeePercent: 0.3,
    };
    const good2: LiquidityPoolShape = {
      dex: 'Splash', identifier: 'good-2', address: 'addr1_good2', assetA: 'lovelace',
      assetB: { policyId: 'a'.repeat(56), nameHex: '00', decimals: 0 }, reserveA: 2n, reserveB: 2n, poolFeePercent: 0.3,
    };

    const { kept, failures } = collectPoolShapes('Splash', [good1, badNoAddress, good2]);

    expect(kept).toHaveLength(2);
    expect(kept.map((k) => k.id)).toEqual(['Splash:good-1', 'Splash:good-2']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.scope).toBe('discover:Splash:bad-no-address');
    expect(failures[0]?.message).toMatch(/no address/);
  });
});
