import { describe, expect, it } from 'vitest';
import { migrate } from '@ctb/db';
import { decimalToScaled } from '@ctb/candles';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgRunRepo, type EquityPoint, type OrderRecord } from '../src/index.js';

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
          networkFeeLovelace: 200_000n, slippageBps: 292, priceImpactBps: 289, poolAfter: null, tsFill: t(5) } },
        { seq: 2, tsIntent: t(5), intent: { side: 'sell', amountIn: 1n, reason: 'y' }, result: { status: 'rejected', reason: 'dust' } },
      ];
      expect(await repo.insertOrders(id, SNEK, orders)).toBe(2);
      await repo.finishRun(id, t(10), { candles: 3, intents: 2, filled: 1, rejected: 1, startEquityLovelace: '1', endEquityLovelace: '2', returnPct: 100, maxDrawdownPct: 0,
        feesLovelace: '2200000', poolFeesIn: '10000000', rejectReasons: { dust: 1 },
        coverage: { candles: 3, first: t(0).toISOString(), last: t(10).toISOString(), expectedBuckets: 3, maxGapMs: 300_000, gapsOverBound: 0 }, warnings: [] });
      const run = await repo.getRun(id);
      expect(run).toMatchObject({ id, strategyId: 'ma-crossover', gitSha: 'abc123', dataSource: 'candles', fillModel: 'cpmm_observed', params: { fast: 12, slow: 48 } });
      expect(run?.finishedAt).toEqual(t(10));
      expect(run?.summary?.rejectReasons).toEqual({ dust: 1 });
      const back = await repo.listOrders(id);
      expect(back).toHaveLength(2);
      expect(back[0]?.result).toMatchObject({ status: 'filled', amountOut: 441_500n, slippageBps: 292, priceImpactBps: 289, tsFill: t(5) });
      expect(run?.summary?.coverage.expectedBuckets).toBe(3);
      // Finding C2: slippage_bps must be reproducible from the mid_price and fill_price stored
      // beside it. It was not, because it was measured against the t+1 pool while mid_price held the
      // t close. Recomputed here straight from the two stored numerics.
      const stored = await db.query<{ mid_price: string; fill_price: string; slippage_bps: number; price_impact_bps: number }>(
        'SELECT mid_price, fill_price, slippage_bps, price_impact_bps FROM paper_orders WHERE run_id = $1 AND seq = 1', [id]);
      const row = stored.rows[0];
      expect(row?.price_impact_bps, 'price impact is stored in its own column, not folded into slippage').toBe(289);
      const mid = decimalToScaled(row?.mid_price ?? '0');
      const fill = decimalToScaled(row?.fill_price ?? '0');
      const recomputed = Math.round(Number(((fill - mid) * 10_000_000n) / mid) / 1000);
      expect(Math.abs((row?.slippage_bps ?? 0) - recomputed)).toBeLessThanOrEqual(1);
      expect(back[1]?.result).toEqual({ status: 'rejected', reason: 'dust' });
    });
  });

  it('persists a paper run incrementally: equity, orders-in-window, heartbeat, status, resume', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [SNEK]);
      const repo = new PgRunRepo(db);
      const id = await repo.createRun({ mode: 'paper', strategyId: 'ma-crossover', params: { fast: 12, slow: 48 }, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10), status: 'running', rehearsal: true });
      const run = await repo.getRun(id);
      expect(run).toMatchObject({ status: 'running', rehearsal: true });

      const points: EquityPoint[] = [
        { tickTs: t(0), cashLovelace: 1_000_000_000n, positionBase: 0n, equityLovelace: 1_000_000_000n, equityExecutableLovelace: 1_000_000_000n, price: '0.5' },
        { tickTs: t(5), cashLovelace: 500_000_000n, positionBase: 900_000n, equityLovelace: 950_000_000n, equityExecutableLovelace: null, price: '0.5' },
        { tickTs: t(10), cashLovelace: 500_000_000n, positionBase: 900_000n, equityLovelace: 980_000_000n, equityExecutableLovelace: 975_000_000n, price: '0.53' },
      ];
      expect(await repo.insertEquity(id, points)).toBe(3);

      const last = await repo.lastEquity(id);
      expect(last).toMatchObject({ tickTs: t(10), cashLovelace: 500_000_000n, positionBase: 900_000n, equityLovelace: 980_000_000n, equityExecutableLovelace: 975_000_000n });

      const windowed = await repo.listEquity(id, t(0), t(5));
      expect(windowed).toHaveLength(2);
      expect(windowed[1]?.equityExecutableLovelace).toBeNull();

      const orders: OrderRecord[] = [
        { seq: 1, tsIntent: t(0), intent: { side: 'buy', amountIn: 1_000_000_000n, reason: 'x' }, result: { status: 'filled', poolId: 'SundaeSwapV3:p', unitIn: 'lovelace', amountIn: 1_000_000_000n,
          unitOut: SNEK, amountOut: 441_500n, midPrice: '0.5', fillPrice: '0.5', poolFeeIn: 10_000_000n, batcherFeeLovelace: 2_000_000n,
          networkFeeLovelace: 200_000n, slippageBps: 0, priceImpactBps: 0, poolAfter: null, tsFill: t(5) } },
        { seq: 2, tsIntent: t(10), intent: { side: 'sell', amountIn: 1n, reason: 'y' }, result: { status: 'rejected', reason: 'dust' } },
      ];
      expect(await repo.insertOrders(id, SNEK, orders)).toBe(2);
      expect(await repo.lastOrderSeq(id)).toBe(2);

      const between = await repo.listOrdersBetween(id, t(0), t(0));
      expect(between).toHaveLength(1);
      expect(between[0]?.seq).toBe(1);

      await repo.heartbeat(id, t(5), t(5));
      const afterHeartbeat = await repo.getRun(id);
      expect(afterHeartbeat?.heartbeatAt).toEqual(t(5));
      expect(afterHeartbeat?.lastTickTs).toEqual(t(5));

      const running = await repo.listRunning();
      expect(running.map((r) => r.id)).toContain(id);

      await repo.setStatus(id, 'aborted', 'boom');
      const aborted = await repo.getRun(id);
      expect(aborted).toMatchObject({ status: 'aborted', stopReason: 'boom' });
      expect(aborted?.finishedAt).not.toBeNull();

      const runningAfter = await repo.listRunning();
      expect(runningAfter.map((r) => r.id)).not.toContain(id);
    });
  });
});

describe.skipIf(!PG_ENABLED)('PgRunRepo.appendResume', () => {
  it('appends ISO timestamps to params.resumes on each call', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [SNEK]);
      const repo = new PgRunRepo(db);
      const id = await repo.createRun({ mode: 'paper', strategyId: 'ma-crossover', params: {}, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10), status: 'running', rehearsal: true });
      await repo.appendResume(id, t(1));
      await repo.appendResume(id, t(2));
      const run = await repo.getRun(id);
      expect(run?.params.resumes).toEqual([t(1).toISOString(), t(2).toISOString()]);
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
