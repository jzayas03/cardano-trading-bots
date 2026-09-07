import { migrate } from '@ctb/db';
import { PgRunRepo } from '@ctb/engine';
import { describe, expect, it } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgDashboardReads } from '../src/reads.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const t = (m: number) => new Date(Date.UTC(2026, 8, 6, 12, m));

describe.skipIf(!PG_ENABLED)('PgDashboardReads.listRuns', () => {
  it('filters, paginates and clamps against three real runs', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [SNEK]);
      const runs = new PgRunRepo(db);
      const reads = new PgDashboardReads(db);

      // id 1: a running paper rehearsal.
      const paperRehearsalId = await runs.createRun({
        mode: 'paper', strategyId: 'ma-crossover', params: {}, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10), status: 'running', rehearsal: true,
      });
      // id 2: a finished backtest.
      const backtestId = await runs.createRun({
        mode: 'backtest', strategyId: 'buy-and-hold', params: {}, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10),
      });
      // id 3: a finished (non-rehearsal) paper run.
      const paperFinishedId = await runs.createRun({
        mode: 'paper', strategyId: 'rsi-mean-reversion', params: {}, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10), status: 'finished',
      });

      const all = await reads.listRuns({}, 10, 0);
      expect(all.map((r) => r.id)).toEqual([paperFinishedId, backtestId, paperRehearsalId]);

      const paperOnly = await reads.listRuns({ mode: 'paper' }, 10, 0);
      expect(paperOnly).toHaveLength(2);
      expect(paperOnly.every((r) => r.mode === 'paper')).toBe(true);

      const running = await reads.listRuns({ status: 'running' }, 10, 0);
      expect(running).toHaveLength(1);
      expect(running[0]?.id).toBe(paperRehearsalId);

      const middle = await reads.listRuns({}, 1, 1);
      expect(middle).toHaveLength(1);
      expect(middle[0]?.id).toBe(backtestId);

      // A caller passing an absurd limit gets the clamp (500), not an unbounded scan — with only
      // three rows in the schema this just proves the call does not throw and returns everything.
      const clamped = await reads.listRuns({}, 9999, 0);
      expect(clamped).toHaveLength(3);

      const byStrategy = await reads.listRuns({ strategy: 'buy-and-hold' }, 10, 0);
      expect(byStrategy.map((r) => r.id)).toEqual([backtestId]);

      const byUnit = await reads.listRuns({ unit: SNEK }, 10, 0);
      expect(byUnit).toHaveLength(3);

      const noMatch = await reads.listRuns({ unit: 'nope' }, 10, 0);
      expect(noMatch).toHaveLength(0);
    });
  });
});
