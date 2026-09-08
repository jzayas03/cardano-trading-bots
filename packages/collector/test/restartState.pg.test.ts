import { migrate } from '@ctb/db';
import { describe, expect, it } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgSnapshotRepo, type CachedPool } from '../src/pure.js';

/**
 * `restartState` and `savePoolCache` against a real schema, because a mocked pool returns rows for
 * relations that were never created and this whole change exists to be read at process start. If
 * `collector_pool_cache` is missing or a column drifts, the collector cold-starts and buys a sweep --
 * the exact failure this closes, reappearing silently.
 *
 * Fixtures sit on either side of exactly one boundary each, so a wrong predicate moves one number.
 */
const P = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const cachedPool = (dex: string, id: string, over: Partial<CachedPool> = {}): CachedPool => ({
  poolId: `${dex}:${id}`, dex, identifier: id, address: `addr_${id}`,
  assetA: 'lovelace', assetB: { policyId: P, nameHex: '41', decimals: 6 },
  reserveA: 1_000n, reserveB: 2_000n, poolFeePercent: 0.3, ...over,
});

describe.skipIf(!PG_ENABLED)('restartState', () => {
  it('reads the discovery clock, the day\'s spend and the last sweep\'s cost from collector_runs', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      const now = new Date('2026-09-08T21:00:00Z');
      const done = { poolsAttempted: 20, poolsFailed: 0, poolsWritten: 20, discovered: false, errors: [] as never[], discoveryCalls: null };

      // yesterday 23:50 UTC discovery: before today's midnight, so its calls are NOT today's spend,
      // but it is still the newest finished discovery if nothing else discovers.
      let id = await repo.startRun(new Date('2026-09-07T23:50:00Z'), new Date('2026-09-07T23:50:01Z'));
      await repo.finishRun(id, new Date('2026-09-07T23:59:00Z'), { ...done, discovered: true, providerCalls: 9_999 });
      // today 00:00 UTC discovery: today's spend, and the clock.
      id = await repo.startRun(new Date('2026-09-08T00:00:00Z'), new Date('2026-09-08T00:00:46Z'));
      await repo.finishRun(id, new Date('2026-09-08T00:09:00Z'), { ...done, discovered: true, providerCalls: 5_691 });
      // today 19:57 UTC discovery: the newest, so it owns both the clock and lastDiscoveryCost.
      id = await repo.startRun(new Date('2026-09-08T19:45:00Z'), new Date('2026-09-08T19:57:04Z'));
      await repo.finishRun(id, new Date('2026-09-08T20:05:00Z'), { ...done, discovered: true, providerCalls: 5_692 });
      // today 20:15 UTC refresh tick: spend only.
      id = await repo.startRun(new Date('2026-09-08T20:15:00Z'), new Date('2026-09-08T20:15:00Z'));
      await repo.finishRun(id, new Date('2026-09-08T20:15:10Z'), { ...done, providerCalls: 297 });
      // an UNFINISHED tick: its calls are unknown, so it must not be invented as zero OR as a number.
      await repo.startRun(new Date('2026-09-08T20:30:00Z'), new Date('2026-09-08T20:30:00Z'));

      const s = await repo.restartState(now);

      expect(s.lastDiscoveryAt).toEqual(new Date('2026-09-08T19:57:04Z'));
      // 5,691 + 5,692 + 297 -- today only, and NOT the 9,999 from yesterday.
      expect(s.callsSpentToday).toBe(11_680);
      expect(s.lastDiscoveryCost).toBe(5_692);
      expect(s.pools).toEqual([]);
    });
  });

  it('returns nulls and an empty set on a database that has never collected', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const s = await new PgSnapshotRepo(db).restartState(new Date('2026-09-08T21:00:00Z'));
      expect(s).toEqual({ lastDiscoveryAt: null, callsSpentToday: 0, lastDiscoveryCost: null, pools: [] });
    });
  });
});

describe.skipIf(!PG_ENABLED)('savePoolCache', () => {
  it('round-trips a pool exactly, ordering and decimals included', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      // assetA is the TOKEN here, not lovelace. That order is the whole reason this table exists:
      // Dexter matches on `${dex}.${assetAName}/${assetBName}.${identifier}`, and `pool_snapshots`
      // normalises the order away.
      const pools = [
        cachedPool('MinswapV2', 'a', { assetA: { policyId: P, nameHex: '534e454b', decimals: 0 }, assetB: 'lovelace' }),
        cachedPool('SundaeSwapV3', 'b', { reserveA: 12_345_678_901_234_567_890n }),
      ];

      await repo.savePoolCache(pools, new Date('2026-09-08T21:00:00Z'));
      const back = (await repo.restartState(new Date('2026-09-08T21:00:00Z'))).pools;

      expect(back).toEqual([...pools].sort((x, y) => x.poolId.localeCompare(y.poolId)));
      // A reserve past 2^63 survives: numeric(40,0) in, BigInt out. `bigint` would have overflowed.
      expect(back.find((p) => p.poolId === 'SundaeSwapV3:b')?.reserveA).toBe(12_345_678_901_234_567_890n);
    });
  });

  it('REPLACES the set, so a delisted pool leaves instead of being refreshed forever', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      await repo.savePoolCache([cachedPool('MinswapV2', 'a'), cachedPool('SundaeSwapV3', 'gone')], new Date('2026-09-08T20:00:00Z'));

      await repo.savePoolCache([cachedPool('MinswapV2', 'a')], new Date('2026-09-08T21:00:00Z'));

      const back = (await repo.restartState(new Date('2026-09-08T21:00:00Z'))).pools;
      expect(back.map((p) => p.poolId)).toEqual(['MinswapV2:a']);
    });
  });

  it('refuses to empty the cache, because an empty cache reads as no cache', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      await repo.savePoolCache([cachedPool('MinswapV2', 'a')], new Date('2026-09-08T20:00:00Z'));

      await expect(repo.savePoolCache([], new Date('2026-09-08T21:00:00Z'))).rejects.toThrow(/refusing to empty the pool cache/);

      // and the previous set is still there, which is the point of refusing rather than obeying
      expect((await repo.restartState(new Date('2026-09-08T21:00:00Z'))).pools).toHaveLength(1);
    });
  });
});
