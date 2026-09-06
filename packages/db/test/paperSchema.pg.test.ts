import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { PG_ENABLED, withTestSchema } from './helpers.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';

describe.skipIf(!PG_ENABLED)('0004_paper_mode', () => {
  it('adds run_equity and the run status columns; existing runs read as finished', async () => {
    await withTestSchema(async (db) => {
      // apply 0001-0003, insert a legacy run, then 0004 on top of it
      const all = await migrate(db);
      expect(all).toContain('0004_paper_mode.sql');
      await db.query(`INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [SNEK]);
      const r = await db.query<{ id: string; status: string; rehearsal: boolean }>(
        `INSERT INTO runs (mode, strategy_id, git_sha, base_unit, data_source, fill_model, data_from, data_to)
         VALUES ('backtest', 'x', 'sha', $1, 'candles', 'cpmm_observed', now(), now()) RETURNING id, status, rehearsal`, [SNEK]);
      expect(r.rows[0]).toMatchObject({ status: 'finished', rehearsal: false });
      await expect(db.query(`UPDATE runs SET status = 'paused' WHERE id = $1`, [r.rows[0]?.id])).rejects.toThrow(/runs_status_check/);
      await db.query(`INSERT INTO run_equity (run_id, tick_ts, cash_lovelace, position_base, equity_lovelace, price) VALUES ($1, now(), 1, 0, 1, 0.5)`, [r.rows[0]?.id]);
      await expect(db.query(`INSERT INTO run_equity (run_id, tick_ts, cash_lovelace, position_base, equity_lovelace, price) VALUES ($1, now() - interval '1 minute', -1, 0, 1, 0.5)`, [r.rows[0]?.id]))
        .rejects.toThrow(/run_equity_cash_lovelace_check/);
    });
  });
});
