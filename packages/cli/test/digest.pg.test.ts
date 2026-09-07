import { PgSnapshotRepo } from '@ctb/collector';
import { migrate } from '@ctb/db';
import { describe, expect, it } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { loadDigestInput } from '../src/commands/status.js';

/**
 * The digest's SQL against a real schema: the UTC-midnight boundary on `started_at`, the 24 h window
 * on `tick_ts`, distinct finished ticks, the newest finished tick by finish time, and the unfinished
 * count. Each fixture row sits on one side of exactly one boundary so a wrong predicate moves one number.
 */
describe.skipIf(!PG_ENABLED)('loadDigestInput', () => {
  it('aggregates collector_runs across the midnight and 24h boundaries', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      const now = new Date('2026-09-07T12:00:00Z');
      const P = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // policy ids are 56 hex chars and unit = policy_id || asset_name_hex (0001_core CHECKs)
      await db.query(`INSERT INTO tokens VALUES ($1 || '41', $1, '41', 'A', 0, 'Meme', '2026-09-05', 'test'), ($1 || '42', $1, '42', 'B', 0, 'Meme', '2026-09-05', 'test')`, [P]);
      const done = { poolsAttempted: 20, poolsFailed: 0, poolsWritten: 20, discovered: false, errors: [] as never[], discoveryCalls: null };
      // yesterday 11:00 UTC: outside 24h, before midnight -> counts nowhere
      let id = await repo.startRun(new Date('2026-09-06T11:00:00Z'), new Date('2026-09-06T11:00:01Z'));
      await repo.finishRun(id, new Date('2026-09-06T11:01:00Z'), { ...done, providerCalls: 9_999 });
      // yesterday 23:50 UTC: inside 24h, before midnight -> ticks/failures yes, calls-today no
      id = await repo.startRun(new Date('2026-09-06T23:50:00Z'), new Date('2026-09-06T23:50:01Z'));
      await repo.finishRun(id, new Date('2026-09-06T23:51:00Z'), { ...done, poolsFailed: 2, providerCalls: 300, errors: [{ scope: 'discover:X', message: 'm' }] as never[] });
      // today 00:10 UTC discovery: everything. Its snapshots carry MuesliSwap and SundaeSwapV3, not MinswapV2 (lost at discovery).
      id = await repo.startRun(new Date('2026-09-07T00:10:00Z'), new Date('2026-09-07T00:10:01Z'));
      const snap = (dex: 'MuesliSwap' | 'SundaeSwapV3' | 'MinswapV2', tick: Date) => ({
        tickTs: tick, dex, poolId: `${dex}:x`, poolAddress: 'addr', baseUnit: `${P}41`, quoteUnit: 'lovelace' as const,
        reserveBase: 1n, reserveQuote: 1n, feeBps: 30, poolType: 'cpmm' as const, tvlLovelace: 2n, blockHeight: 1, observedAt: new Date(tick.getTime() + 1000),
      });
      await repo.insertSnapshots(id, [snap('MuesliSwap', new Date('2026-09-07T00:10:00Z')), snap('SundaeSwapV3', new Date('2026-09-07T00:10:00Z'))]);
      await repo.finishRun(id, new Date('2026-09-07T00:19:00Z'), { ...done, discovered: true, providerCalls: 5_691, discoveryCalls: { MinswapV2: 5_691 } });
      // today 11:40 UTC refresh tick that retried the lost MinswapV2 and got it back: 3,358 calls of
      // which 3,300 are the venue scan (discovery_calls) and 58 recurring refresh
      id = await repo.startRun(new Date('2026-09-07T11:40:00Z'), new Date('2026-09-07T11:40:01Z'));
      await repo.insertSnapshots(id, [snap('MinswapV2', new Date('2026-09-07T11:40:00Z')), snap('SundaeSwapV3', new Date('2026-09-07T11:40:00Z'))]);
      await repo.finishRun(id, new Date('2026-09-07T11:41:00Z'), { ...done, providerCalls: 3_358, discoveryCalls: { MinswapV2: 3_300 } });
      // today 11:50 UTC refresh: newest finished
      id = await repo.startRun(new Date('2026-09-07T11:50:00Z'), new Date('2026-09-07T11:50:01Z'));
      await repo.finishRun(id, new Date('2026-09-07T11:51:00Z'), { ...done, providerCalls: 210 });
      // two days ago, never finished (a killed process): outside 24h -> not an unfinished run anymore
      await repo.startRun(new Date('2026-09-05T12:00:00Z'), new Date('2026-09-05T12:00:01Z'));
      // today 12:00 UTC: in flight, never finished -> unfinished only; its calls are still 0
      await repo.startRun(new Date('2026-09-07T12:00:00Z'), new Date('2026-09-07T12:00:01Z'));

      // The newest (refresh) tick holds SundaeSwapV3 only. MuesliSwap was found at discovery but is not refreshed (deepest policy); MinswapV2 was lost at discovery and retried back in at 11:40, so it is NOT lost.
      await repo.insertSnapshots(id, [snap('SundaeSwapV3', new Date('2026-09-07T11:50:00Z'))]);
      const d = await loadDigestInput(db, 600, ['MinswapV2', 'MuesliSwap', 'SundaeSwapV3'], now);
      expect(d.lastFinished).toMatchObject({ tickTs: new Date('2026-09-07T11:50:00Z'), finishedAt: new Date('2026-09-07T11:51:00Z'), poolsWritten: 20, providerCalls: 210, discovered: false });
      expect(d.ticksLast24h).toBe(4);
      expect(d.discoveryCallsToday).toBe(5_691 + 3_300);
      expect(d.refreshCallsToday).toBe(210 + 58);
      expect(d.venuesConfigured).toEqual(['MinswapV2', 'MuesliSwap', 'SundaeSwapV3']);
      expect(d.venuesSinceLastDiscovery).toEqual(['MinswapV2', 'MuesliSwap', 'SundaeSwapV3']);
      expect(d.venuesInLastTick).toEqual(['SundaeSwapV3']);
      expect(d.tokensTotal).toBe(2);
      expect(d.tokensCoveredInLastTick).toBe(1);
      expect(d.lastDiscoveryAt).toEqual(new Date('2026-09-07T00:10:00Z'));
      expect(d.poolFailures24h).toBe(2);
      expect(d.venueErrors24h).toBe(1);
      expect(d.unfinishedRuns).toBe(1);
    });
  });
});
