import { describe, expect, it } from 'vitest';
import { migrate } from '@ctb/db';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgRunRepo, type OrderRecord } from '../src/index.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const t = (m: number) => new Date(Date.UTC(2026, 8, 6, 12, m));

describe.skipIf(!PG_ENABLED)('PgRunRepo', () => {
  it('creates a run, stores filled and rejected orders, finishes with a summary, reads back', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [SNEK]);
      const repo = new PgRunRepo(db);
      const id = await repo.createRun({ mode: 'backtest', strategyId: 'ma-crossover', params: { fast: 12, slow: 48 }, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10) });
      const orders: OrderRecord[] = [
        { seq: 1, tsIntent: t(0), intent: { side: 'buy', amountIn: 1_000_000_000n, reason: 'x' }, result: { status: 'filled', poolId: 'SundaeSwapV3:p', unitIn: 'lovelace', amountIn: 1_000_000_000n,
          unitOut: SNEK, amountOut: 441_500n, midPrice: '0.002200718703104284', fillPrice: '0.002265005662514156', poolFeeIn: 10_000_000n, batcherFeeLovelace: 2_000_000n,
          networkFeeLovelace: 200_000n, slippageBps: 292, tsFill: t(5) } },
        { seq: 2, tsIntent: t(5), intent: { side: 'sell', amountIn: 1n, reason: 'y' }, result: { status: 'rejected', reason: 'dust' } },
      ];
      expect(await repo.insertOrders(id, SNEK, orders)).toBe(2);
      await repo.finishRun(id, t(10), { candles: 3, intents: 2, filled: 1, rejected: 1, startEquityLovelace: '1', endEquityLovelace: '2', returnPct: 100, maxDrawdownPct: 0,
        feesLovelace: '2200000', poolFeesIn: '10000000', rejectReasons: { dust: 1 } });
      const run = await repo.getRun(id);
      expect(run).toMatchObject({ id, strategyId: 'ma-crossover', gitSha: 'abc123', dataSource: 'candles', fillModel: 'cpmm_observed', params: { fast: 12, slow: 48 } });
      expect(run?.finishedAt).toEqual(t(10));
      expect(run?.summary?.rejectReasons).toEqual({ dust: 1 });
      const back = await repo.listOrders(id);
      expect(back).toHaveLength(2);
      expect(back[0]?.result).toMatchObject({ status: 'filled', amountOut: 441_500n, slippageBps: 292, tsFill: t(5) });
      expect(back[1]?.result).toEqual({ status: 'rejected', reason: 'dust' });
    });
  });
});

/**
 * Final-review finding C1: `paper_orders` binds 20 parameters per row, so a single multi-row INSERT
 * broke at 3277 orders — reachable in one long backtest. The repo now chunks at 1000 rows inside one
 * transaction.
 */
describe.skipIf(!PG_ENABLED)('PgRunRepo bulk insert (finding C1)', () => {
  it('inserts 4000 orders in one transaction, well past the 65535 bind-parameter limit', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [SNEK]);
      const repo = new PgRunRepo(db);
      const id = await repo.createRun({ mode: 'backtest', strategyId: 'ma-crossover', params: {}, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10) });
      const orders: OrderRecord[] = Array.from({ length: 4000 }, (_, i) => ({
        seq: i + 1, tsIntent: t(i), intent: { side: 'buy' as const, amountIn: 1_000n, reason: 'bulk' },
        result: { status: 'rejected' as const, reason: 'dust' },
      }));
      expect(await repo.insertOrders(id, SNEK, orders)).toBe(4000);
      const count = await db.query<{ n: string }>('SELECT count(*) AS n FROM paper_orders WHERE run_id = $1', [id]);
      expect(count.rows[0]?.n).toBe('4000');
    });
  });

  it('rolls the whole chunked insert back when a later chunk fails', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [SNEK]);
      const repo = new PgRunRepo(db);
      const id = await repo.createRun({ mode: 'backtest', strategyId: 'ma-crossover', params: {}, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10) });
      const orders: OrderRecord[] = Array.from({ length: 1500 }, (_, i) => ({
        // seq 1200 (second chunk) repeats seq 1, violating the (run_id, seq) primary key
        seq: i === 1200 ? 1 : i + 1, tsIntent: t(i), intent: { side: 'buy' as const, amountIn: 1_000n, reason: 'bulk' },
        result: { status: 'rejected' as const, reason: 'dust' },
      }));
      await expect(repo.insertOrders(id, SNEK, orders)).rejects.toThrow();
      const count = await db.query<{ n: string }>('SELECT count(*) AS n FROM paper_orders WHERE run_id = $1', [id]);
      expect(count.rows[0]?.n, 'the first chunk must not survive a failure in the second').toBe('0');
    });
  });
});
