import { describe, expect, it } from 'vitest';
import { migrate } from '@ctb/db';
import { missingTicksCell } from '@ctb/reports';
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
    observedAt: tickTs, isPrimary: true,
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
   * Offsets are relative to the ACTUAL test-execution instant (`Date.now()`), not a fixed calendar
   * date, because the query compares against Postgres's own `now()` — there is no `now` parameter to
   * fix (unlike `digestInput`, which takes one). Every tick sits on a half-hour offset so no row can
   * ever land within seconds of the 24h boundary and flip across it under test-execution latency.
   *
   * What these three cases pin is not arithmetic, it is a refusal. `missingTicksApprox` is told an
   * interval by whatever `.env` the CALLING process loaded, which need not be the one the collector
   * service runs with; on 2026-09-12 it was not, and `status` printed `-191` while the digest printed
   * a clamped, reassuring `(0 missing)`. So the query now also measures the cadence from the rows
   * themselves, and `missingTicksCell` prints a count only when the two agree.
   */
  describe('missingTicksApprox', () => {
    it('counts the hole when the observed cadence agrees with the configured one', async () => {
      await withTestSchema(async (db) => {
        await migrate(db);
        const repo = new PgSnapshotRepo(db);
        const now = Date.now();
        // 24 hourly slots inside the window (0.5h .. 23.5h ago), with the 12.5h one left out: exactly
        // one genuine hole, and a 7200s gap where a 3600s one belongs.
        for (const hoursAgo of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5,
          13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5, 21.5, 22.5, 23.5]) {
          const tick = new Date(now - hoursAgo * 3_600_000);
          await repo.startRun(tick, tick);
        }
        const outsideWindow = new Date(now - 25 * 3_600_000);
        await repo.startRun(outsideWindow, outsideWindow);

        const cadence = await repo.missingTicksApprox(3600);
        expect(cadence).toEqual({ ticks: 23, expected: 24, configuredIntervalSec: 3600, observedIntervalSec: 3600 });
        expect(missingTicksCell(cadence)).toBe('1');
      });
    });

    it('refuses a count when the observed cadence disagrees with the configured interval', async () => {
      await withTestSchema(async (db) => {
        await migrate(db);
        const repo = new PgSnapshotRepo(db);
        const now = Date.now();
        // The live 2026-09-12 shape in miniature: rows written every 300 s (the focus interval) while
        // the caller passes 900 (the candle interval). 120 five-minute ticks over the most recent 10 h
        // already outnumber the 96 slots a 900 s interval predicts for a whole DAY, which is precisely
        // how the old expected-minus-count arithmetic went negative.
        for (let i = 1; i <= 120; i += 1) {
          const tick = new Date(now - i * 300_000);
          await repo.startRun(tick, tick);
        }

        const cadence = await repo.missingTicksApprox(900);
        expect(cadence?.observedIntervalSec).toBe(300);
        expect(cadence?.configuredIntervalSec).toBe(900);
        // The number the old code would have printed. Pinned so the regression is named, not implied.
        expect(cadence!.expected - cadence!.ticks).toBeLessThan(0);
        expect(missingTicksCell(cadence)).toBe('n/a (observed 300s cadence, configured 900s — one of them is wrong)');
      });
    });

    it('refuses a count when there are too few ticks to measure a cadence', async () => {
      await withTestSchema(async (db) => {
        await migrate(db);
        const repo = new PgSnapshotRepo(db);
        const tick = new Date(Date.now() - 3_600_000);
        await repo.startRun(tick, tick);

        const cadence = await repo.missingTicksApprox(3600);
        expect(cadence).toEqual({ ticks: 1, expected: 24, configuredIntervalSec: 3600, observedIntervalSec: null });
        // A collector dead for 23 of the last 24 hours must not be summarised as a tidy "23 missing"
        // derived from an interval nothing in the data corroborates.
        expect(missingTicksCell(cadence)).toBe('n/a (1 tick in 24h — too few to measure a cadence)');
      });
    });
  });
});
