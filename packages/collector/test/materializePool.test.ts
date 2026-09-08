import { Asset, LiquidityPool } from '@indigo-labs/dexter';
import { describe, expect, it } from 'vitest';
import { materializePool, type LiquidityPoolShape } from '../src/dexterSource.js';

/**
 * The crux of the pool cache, and the one part of it that a fake cannot check.
 *
 * `FetchRequest.getLiquidityPoolState` matches the refreshed pool to the requested one on
 * `pool.uuid === liquidityPool.uuid`. `uuid` is a getter on Dexter's `LiquidityPool`, so a pool read
 * back from the database as a plain object has `uuid === undefined`, matches nothing, and every
 * refresh returns empty -- while `knownPoolCount()` stays non-zero, so discovery never re-runs and
 * the collector writes nothing until someone notices. That failure is worse than the bug the cache
 * fixes, which is why this is asserted against Dexter's OWN derivation rather than a copy of it.
 */
const SNEK = { policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', nameHex: '534e454b', decimals: 0 };

/** A pool exactly as Dexter's discovery produces it. */
function dexterPool(assetAIsAda: boolean): LiquidityPool {
  const token = new Asset(SNEK.policyId, SNEK.nameHex, SNEK.decimals);
  const pool = assetAIsAda
    ? new LiquidityPool('MinswapV2', 'lovelace' as unknown as Asset, token, 100n, 50n, 'addr_pool')
    : new LiquidityPool('MinswapV2', token, 'lovelace' as unknown as Asset, 50n, 100n, 'addr_pool');
  pool.identifier = 'abc123';
  pool.poolFeePercent = 0.3;
  return pool;
}

/** The same pool after a database round trip: a plain object, no prototype, no getters. */
function throughTheCache(pool: LiquidityPool): LiquidityPoolShape {
  const side = (a: unknown) => (a === 'lovelace' ? 'lovelace' : { policyId: (a as Asset).policyId, nameHex: (a as Asset).nameHex, decimals: (a as Asset).decimals });
  return JSON.parse(JSON.stringify({
    dex: pool.dex, identifier: pool.identifier, address: pool.address,
    assetA: side(pool.assetA), assetB: side(pool.assetB), poolFeePercent: pool.poolFeePercent,
  })) as LiquidityPoolShape;
}

describe('materializePool', () => {
  it.each([true, false])('reproduces Dexter\'s own uuid after a round trip (assetA is ADA: %s)', (assetAIsAda) => {
    const original = dexterPool(assetAIsAda);
    const plain = { ...throughTheCache(original), reserveA: original.reserveA, reserveB: original.reserveB };

    // The defect this guards: a plain object has no uuid at all.
    expect((plain as unknown as LiquidityPool).uuid).toBeUndefined();

    const rebuilt = materializePool(plain) as unknown as LiquidityPool;

    expect(rebuilt.uuid).toBe(original.uuid);
    expect(rebuilt).toBeInstanceOf(LiquidityPool);
  });

  it('keeps the asset ORDER, which the uuid depends on', () => {
    // `pool_snapshots` normalises every pool to base/quote and throws this order away. If the cache
    // did the same, half the pools would come back as ADA/SNEK when Dexter knows them as SNEK/ADA,
    // and their uuids would silently not match.
    const adaFirst = materializePool(dexterPool(true)) as unknown as LiquidityPool;
    const tokenFirst = materializePool(dexterPool(false)) as unknown as LiquidityPool;
    expect(adaFirst.uuid).not.toBe(tokenFirst.uuid);
    expect(adaFirst.uuid).toContain('ADA/SNEK');
    expect(tokenFirst.uuid).toContain('SNEK/ADA');
  });

  it('passes a real LiquidityPool through untouched, so the discovery path is unchanged', () => {
    const original = dexterPool(true);
    expect(materializePool(original as unknown as LiquidityPoolShape)).toBe(original);
  });

  it('carries the identifier and fee, which the constructor does not take', () => {
    const rebuilt = materializePool(dexterPool(true) as unknown as LiquidityPoolShape) as unknown as LiquidityPool;
    expect(rebuilt.identifier).toBe('abc123');
    expect(rebuilt.poolFeePercent).toBe(0.3);
  });
});
