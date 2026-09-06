import { describe, expect, it } from 'vitest';
import { migrate } from '@ctb/db';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgSnapshotRepo, type SnapshotRow } from '../src/index.js';

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
      });
      const runs = await repo.lastRuns(5);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: runId, poolsWritten: 2, providerCalls: 3, discovered: true });
      expect(runs[0]?.finishedAt).toEqual(new Date('2026-09-05T15:05:09Z'));
      const stored = await db.query<{ reserve_quote: string }>('SELECT reserve_quote FROM pool_snapshots ORDER BY pool_id');
      expect(stored.rows[0]?.reserve_quote).toBe('52331970594');
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
});
