import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { PG_ENABLED, withTestSchema } from './helpers.js';

describe.skipIf(!PG_ENABLED)('migrate (postgres)', () => {
  it('applies pending migrations once and is idempotent', async () => {
    await withTestSchema(async (db) => {
      const first = await migrate(db);
      expect(first).toEqual(['0001_core.sql', '0002_candles_engine.sql']);
      const second = await migrate(db);
      expect(second).toEqual([]);
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1`,
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual([
        'candles',
        'candles_external',
        'collector_runs',
        'external_pool_map',
        'paper_orders',
        'pool_snapshots',
        'runs',
        'schema_migrations',
        'tokens',
      ]);
    });
  });

  it('rejects a non-cpmm pool_type at the database', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(
        `INSERT INTO tokens VALUES ('279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b',
          '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`,
      );
      const run = await db.query<{ id: string }>(
        `INSERT INTO collector_runs (tick_ts, started_at) VALUES (now(), now()) RETURNING id`,
      );
      await expect(
        db.query(
          `INSERT INTO pool_snapshots (run_id, tick_ts, dex, pool_id, pool_address, base_unit, reserve_base, reserve_quote,
             fee_bps, pool_type, tvl_lovelace, block_height, observed_at)
           VALUES ($1, now(), 'MinswapV2', 'MinswapV2:x', 'addr1x', '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b',
             1, 1, 30, 'stable', 2, 1, now())`,
          [run.rows[0]?.id],
        ),
      ).rejects.toThrow(/pool_snapshots_pool_type_check/);
    });
  });
});
