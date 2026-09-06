import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { PG_ENABLED, withTestSchema } from './helpers.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';

async function seedSnek(db: import('pg').Pool): Promise<void> {
  await db.query(
    `INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`,
    [SNEK],
  );
}

describe.skipIf(!PG_ENABLED)('0002_candles_engine', () => {
  it('applies after 0001 and creates the five tables', async () => {
    await withTestSchema(async (db) => {
      const applied = await migrate(db);
      // Scoped assertion: 0003+ appends more filenames to this list. This is 0002's own test, so
      // assert 0002 ran last and 0001 ran before it — not the exact full list — so a later
      // migration's PR never has to touch this file to pass.
      expect(applied[applied.length - 1]).toBe('0002_candles_engine.sql');
      expect(applied).toContain('0001_core.sql');
      const t = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1`,
      );
      const tableNames = new Set(t.rows.map((r) => r.table_name));
      // Scoped assertion: only 0002's own five tables are a required subset, not the whole
      // schema — a later migration's PR never has to touch this file to add its own tables.
      for (const table of ['candles', 'candles_external', 'external_pool_map', 'runs', 'paper_orders']) {
        expect(tableNames.has(table), `expected table ${table}`).toBe(true);
      }
    });
  });

  it('paper_orders enforces the filled/rejected shape', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedSnek(db);
      const run = await db.query<{ id: string }>(
        `INSERT INTO runs (mode, strategy_id, git_sha, base_unit, data_source, fill_model, data_from, data_to)
         VALUES ('backtest', 'ma-crossover', 'abc', $1, 'candles', 'cpmm_observed', now(), now()) RETURNING id`,
        [SNEK],
      );
      const runId = run.rows[0]?.id;
      await expect(
        db.query(
          `INSERT INTO paper_orders (run_id, seq, ts_intent, base_unit, side, unit_in, amount_in, status, reason)
           VALUES ($1, 1, now(), $2, 'buy', 'lovelace', 1000, 'filled', 'test')`,
          [runId, SNEK],
        ),
      ).rejects.toThrow(/paper_orders_check/);
      await db.query(
        `INSERT INTO paper_orders (run_id, seq, ts_intent, base_unit, side, unit_in, amount_in, status, reject_reason, reason)
         VALUES ($1, 1, now(), $2, 'buy', 'lovelace', 1000, 'rejected', 'no t+1 candle', 'test')`,
        [runId, SNEK],
      );
    });
  });

  it('runs rejects an unknown fill model', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedSnek(db);
      await expect(
        db.query(
          `INSERT INTO runs (mode, strategy_id, git_sha, base_unit, data_source, fill_model, data_from, data_to)
           VALUES ('backtest', 'x', 'abc', $1, 'candles', 'flat_slippage', now(), now())`,
          [SNEK],
        ),
      ).rejects.toThrow(/runs_fill_model_check/);
    });
  });
});
