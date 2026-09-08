import { migrate } from '@ctb/db';
import { describe, expect, it } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';

/**
 * The `samples` subquery, against a real schema.
 *
 * Everything else in this report is pure and unit-tested. This one number is SQL, and it decides
 * whether a candle counts as measured at all -- get it wrong and the report either silently drops
 * every candle (reporting "NOT MEASURED" forever) or counts snapshots from a pool whose prices never
 * fed the candle, claiming a range was measured from samples that did not produce it.
 */
const P = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNIT = `${P}534e454b`;
const T = (m: number) => new Date(Date.UTC(2026, 8, 9, 0, m, 0));

const SAMPLES_SQL = `
  SELECT c.pool_id,
         (SELECT count(*) FROM pool_snapshots s
           WHERE s.pool_id = c.pool_id AND s.base_unit = c.base_unit
             AND s.tick_ts >= c.tick_ts
             AND s.tick_ts <  c.tick_ts + make_interval(secs => $1::int)) AS samples
    FROM candles c WHERE c.base_unit = $2 ORDER BY c.tick_ts`;

describe.skipIf(!PG_ENABLED)('the samples subquery', () => {
  it('counts only this candle\'s own pool, inside its own bucket', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, $2, '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [UNIT, P]);
      const runId = (await db.query<{ id: string }>(
        `INSERT INTO collector_runs (tick_ts, started_at) VALUES ($1, $1) RETURNING id`, [T(0)])).rows[0]!.id;
      const snap = async (poolId: string, m: number) => db.query(
        `INSERT INTO pool_snapshots (run_id, tick_ts, dex, pool_id, pool_address, base_unit, quote_unit,
           reserve_base, reserve_quote, fee_bps, pool_type, tvl_lovelace, block_height, observed_at)
         VALUES ($1,$2,'MinswapV2',$3,'addr',$4,'lovelace',1000,2000,30,'cpmm',4000,1,$2)`,
        [runId, T(m), poolId, UNIT]);
      // The candle's own pool: 3 samples inside the 15-minute bucket starting at 00:00.
      await snap('MinswapV2:deep', 0); await snap('MinswapV2:deep', 3); await snap('MinswapV2:deep', 6);
      // A DIFFERENT pool in the same bucket -- buildCandles ignores these, so they must not be counted.
      await snap('SundaeSwapV3:other', 3); await snap('SundaeSwapV3:other', 9);
      // The same pool one bucket LATER -- outside the window, must not be counted.
      await snap('MinswapV2:deep', 15);
      await db.query(
        `INSERT INTO candles (base_unit, tick_ts, pool_id, open, high, low, close, close_reserve_base,
           close_reserve_quote, fee_bps, pool_type, tvl_lovelace)
         VALUES ($1,$2,'MinswapV2:deep',1,1.1,0.9,1,1000,2000,30,'cpmm',4000)`, [UNIT, T(0)]);

      const rows = await db.query<{ pool_id: string; samples: string }>(SAMPLES_SQL, [900, UNIT]);

      expect(rows.rows).toHaveLength(1);
      // 3, not 5 (other pool) and not 4 (next bucket).
      expect(Number(rows.rows[0]!.samples)).toBe(3);
    });
  });

  it('returns 1 for a single-sample candle, so the report can call it not measurable', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, $2, '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [UNIT, P]);
      const runId = (await db.query<{ id: string }>(
        `INSERT INTO collector_runs (tick_ts, started_at) VALUES ($1, $1) RETURNING id`, [T(0)])).rows[0]!.id;
      await db.query(
        `INSERT INTO pool_snapshots (run_id, tick_ts, dex, pool_id, pool_address, base_unit, quote_unit,
           reserve_base, reserve_quote, fee_bps, pool_type, tvl_lovelace, block_height, observed_at)
         VALUES ($1,$2,'MinswapV2','MinswapV2:deep','addr',$3,'lovelace',1000,2000,30,'cpmm',4000,1,$2)`,
        [runId, T(0), UNIT]);
      await db.query(
        `INSERT INTO candles (base_unit, tick_ts, pool_id, open, high, low, close, close_reserve_base,
           close_reserve_quote, fee_bps, pool_type, tvl_lovelace)
         VALUES ($1,$2,'MinswapV2:deep',1,1,1,1,1000,2000,30,'cpmm',4000)`, [UNIT, T(0)]);

      const rows = await db.query<{ samples: string }>(SAMPLES_SQL, [900, UNIT]);
      expect(Number(rows.rows[0]!.samples)).toBe(1);
    });
  });
});
