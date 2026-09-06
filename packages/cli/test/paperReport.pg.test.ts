import { migrate } from '@ctb/db';
import { PgRunRepo, type EquityPoint, type OrderRecord } from '@ctb/engine';
import { describe, expect, it, vi } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { printReport, summarizeRun } from '../src/commands/report.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const t = (m: number): Date => new Date(Date.UTC(2026, 8, 6, 12, m));

const equityAt = (m: number, equity: bigint): EquityPoint => ({
  tickTs: t(m), cashLovelace: equity, positionBase: 0n, equityLovelace: equity, equityExecutableLovelace: equity, price: '1.0',
});

const filledAt = (seq: number, m: number): OrderRecord => ({
  seq, tsIntent: t(m), intent: { side: 'buy', amountIn: 1_000_000n, reason: 'signal' },
  result: {
    status: 'filled', poolId: 'Minswap:p', unitIn: 'lovelace', amountIn: 1_000_000n, unitOut: SNEK, amountOut: 900_000n,
    midPrice: '1.0', fillPrice: '1.01', poolFeeIn: 3_000n, batcherFeeLovelace: 0n, networkFeeLovelace: 200_000n,
    slippageBps: 10, priceImpactBps: 5, poolAfter: null, tsFill: t(m + 1),
  },
});

/**
 * Final-review finding C1: after a resume, `runs.summary` holds only the LAST segment's numbers —
 * `finishRun` overwrites it wholesale when the resumed process exits, and the in-process `Summarizer`
 * only ever saw the candles of its own segment. Verified on the real rehearsal run 6: the row's
 * summary said 1 intent / 1 filled / 12 candles while `paper_orders` held 2 rows and `run_equity`
 * held 27. The paper headline must therefore be recomputed from the persisted rows, with the
 * segment-scoped `runs.summary` kept below it and labelled as such.
 */
describe.skipIf(!PG_ENABLED)('printReport paper headline over two segments (finding C1)', () => {
  it('counts both segments in the persisted headline while runs.summary still describes only the last', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(
        `INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`,
        [SNEK],
      );
      const runs = new PgRunRepo(db);
      const id = await runs.createRun({
        mode: 'paper', strategyId: 'ma-crossover', params: { fast: 3, slow: 6 }, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(0), status: 'running', rehearsal: true,
      });

      // Segment 1: three equity points and one fill, then a stop.
      await runs.insertEquity(id, [equityAt(0, 1_000_000_000n), equityAt(1, 1_000_100_000n), equityAt(2, 1_000_200_000n)]);
      await runs.insertOrders(id, SNEK, [filledAt(1, 1)]);
      await runs.setStatus(id, 'finished', 'signal');

      // Resume: segment 2 adds three more equity points and a second fill.
      await runs.appendResume(id, t(3));
      await runs.setStatus(id, 'running', null);
      await runs.insertEquity(id, [equityAt(3, 1_000_300_000n), equityAt(4, 1_000_400_000n), equityAt(5, 1_000_500_000n)]);
      await runs.insertOrders(id, SNEK, [filledAt(2, 4)]);
      // The resumed process's own summary sees only its own segment — this is the defect's source.
      await runs.finishRun(id, t(6), {
        candles: 3, intents: 1, filled: 1, rejected: 0, startEquityLovelace: '1000300000', endEquityLovelace: '1000500000',
        returnPct: 0.02, maxDrawdownPct: 0, feesLovelace: '200000', poolFeesIn: '3000', rejectReasons: {},
        coverage: { candles: 3, first: t(3).toISOString(), last: t(5).toISOString(), expectedBuckets: 3, maxGapMs: 60_000, gapsOverBound: 0 },
        warnings: [],
      });
      await runs.setStatus(id, 'finished', 'signal');

      const run = await runs.getRun(id);
      expect(run).not.toBeNull();
      const orders = await runs.listOrders(id);
      const equity = await runs.listEquity(id, new Date(0), t(59));
      expect(orders).toHaveLength(2);
      expect(equity).toHaveLength(6);
      // The pure summarizer over the persisted rows sees BOTH segments.
      expect(summarizeRun(equity, orders)).toMatchObject({ points: 6, filled: 2, rejected: 0 });
      // ...while the stored per-segment summary still says one.
      expect(run?.summary?.filled).toBe(1);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
      try {
        printReport(run!, orders, 'SNEK', equity);
        const lines = logSpy.mock.calls.map((c) => String(c[0]));
        expect(lines.some((l) => l.includes('summary (from persisted rows)'))).toBe(true);
        expect(lines.some((l) => l.includes('last segment summary'))).toBe(true);
        expect(lines.some((l) => /resumes: 1/.test(l))).toBe(true);
        const headline = tableSpy.mock.calls[0]?.[0] as Array<Record<string, unknown>> | undefined;
        expect(headline?.[0]).toMatchObject({ points: 6, filled: 2 });
      } finally {
        tableSpy.mockRestore();
        logSpy.mockRestore();
      }
    });
  });
});
