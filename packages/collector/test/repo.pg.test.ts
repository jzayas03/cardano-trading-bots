import { describe, expect, it } from 'vitest';
import { migrate } from '@ctb/db';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgSnapshotRepo, type SnapshotRow } from '../src/pure.js';

const snek = {
  ticker: 'SNEK',
  policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f',
  assetNameHex: '534e454b',
  decimals: 0,
  category: 'Meme',
  unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b',
};

function row(poolId: string, tickTs: Date): SnapshotRow {
  return {
    tickTs,
    dex: 'SundaeSwapV3',
    poolId,
    poolAddress: 'addr1_x',
    baseUnit: snek.unit,
    quoteUnit: 'lovelace',
    reserveBase: 23_779_491n,
    reserveQuote: 52_331_970_594n,
    feeBps: 100,
    poolType: 'cpmm',
    tvlLovelace: 104_663_941_188n,
    blockHeight: 1,
    observedAt: tickTs,
  };
}

describe.skipIf(!PG_ENABLED)('PgSnapshotRepo', () => {
  it('records a run, its snapshots, and reads it back', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      await repo.syncTokens([snek], { seededAt: '2026-09-05', seedSource: 'test' });
      await repo.syncTokens([snek], { seededAt: '2026-09-05', seedSource: 'test' }); // idempotent
      const tick = new Date('2026-09-05T15:05:00Z');
      const runId = await repo.startRun(tick, new Date('2026-09-05T15:05:01Z'));
      const written = await repo.insertSnapshots(runId, [row('SundaeSwapV3:a', tick), row('SundaeSwapV3:b', tick)]);
      expect(written).toBe(2);
      const again = await repo.insertSnapshots(runId, [row('SundaeSwapV3:a', tick)]);
      expect(again).toBe(0); // same pool, same tick: idempotent
      await repo.finishRun(runId, new Date('2026-09-05T15:05:09Z'), {
        poolsAttempted: 2, poolsFailed: 0, poolsWritten: 2, providerCalls: 3, discovered: true, errors: [],
        discoveryCalls: { SundaeSwapV3: 3 },
      });
      const runs = await repo.lastRuns(5);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: runId, poolsWritten: 2, providerCalls: 3, discovered: true, discoveryCalls: { SundaeSwapV3: 3 },
      });
      expect(runs[0]?.finishedAt).toEqual(new Date('2026-09-05T15:05:09Z'));
      const stored = await db.query<{ reserve_quote: string }>('SELECT reserve_quote FROM pool_snapshots ORDER BY pool_id');
      expect(stored.rows[0]?.reserve_quote).toBe('52331970594');
    });
  });

  it('round-trips a null discoveryCalls (refresh tick) as null, not as JSON "null" or an empty object', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      const tick = new Date('2026-09-05T15:10:00Z');
      const runId = await repo.startRun(tick, tick);
      await repo.finishRun(runId, tick, {
        poolsAttempted: 0, poolsFailed: 0, poolsWritten: 0, providerCalls: 1, discovered: false, errors: [],
        discoveryCalls: null,
      });
      const runs = await repo.lastRuns(1);
      expect(runs[0]?.discoveryCalls).toBeNull();
    });
  });

  it('refuses a snapshot for a token that is not in the universe', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      const tick = new Date('2026-09-05T15:05:00Z');
      const runId = await repo.startRun(tick, tick);
      await expect(repo.insertSnapshots(runId, [row('SundaeSwapV3:a', tick)])).rejects.toThrow(/pool_snapshots_base_unit_fkey/);
    });
  });

  /**
   * `perVenuePoolCounts` moved verbatim off `status`'s own former inline query (see `repo.ts`'s
   * comment on it) — this proves it against a real schema, not just against the recording stand-in
   * `readOnly.guard.test.ts` uses for its SELECT/WITH shape check. Two dexes at the SAME newest tick,
   * an older tick with a third, so a wrong `WHERE tick_ts = (SELECT max(tick_ts) ...)` predicate would
   * either drop a row that belongs or leak in the older one.
   */
  it('perVenuePoolCounts counts pools per dex at the newest tick only, ordered by dex', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      await repo.syncTokens([snek], { seededAt: '2026-09-05', seedSource: 'test' });
      const older = new Date('2026-09-05T15:00:00Z');
      const newer = new Date('2026-09-05T15:10:00Z');
      let runId = await repo.startRun(older, older);
      await repo.insertSnapshots(runId, [row('SundaeSwapV3:old', older)]);

      runId = await repo.startRun(newer, newer);
      await repo.insertSnapshots(runId, [
        row('SundaeSwapV3:a', newer), row('SundaeSwapV3:b', newer),
        { ...row('MinswapV2:x', newer), dex: 'MinswapV2' },
      ]);

      const perVenue = await repo.perVenuePoolCounts();
      expect(perVenue).toEqual([
        { dex: 'MinswapV2', pools: 1, tickTs: newer },
        { dex: 'SundaeSwapV3', pools: 2, tickTs: newer },
      ]);
    });
  });

  /**
   * `missingTicksApprox` moved verbatim off `status`'s own former inline query. Offsets are relative
   * to the ACTUAL test-execution instant (`Date.now()`), not a fixed calendar date, because the query
   * itself compares against Postgres's own `now()` — there is no `now` parameter to fix (unlike
   * `digestInput`, which takes one). Three ticks sit hours inside the 24h window and one sits an hour
   * past it, deliberately far from the boundary so test execution latency can never flip a row across
   * it. `intervalSec=3600` makes the expected-tick count exactly `86400 / 3600 = 24`, deterministically
   * — `now() - (now() - interval '24 hours')` is exactly `interval '24 hours'` within one statement
   * (Postgres evaluates `now()` once per transaction), so this numerator never depends on wall-clock
   * timing either.
   */
  it('missingTicksApprox counts distinct ticks missing from the last 24h', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      const now = Date.now();
      for (const hoursAgo of [1, 5, 10]) {
        const tick = new Date(now - hoursAgo * 3_600_000);
        await repo.startRun(tick, tick);
      }
      const outsideWindow = new Date(now - 25 * 3_600_000);
      await repo.startRun(outsideWindow, outsideWindow);

      const missing = await repo.missingTicksApprox(3600);
      expect(missing).toBe('21'); // 24 expected ticks - 3 actual distinct ticks inside the 24h window
    });
  });
});
