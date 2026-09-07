import type { RunSummaryStats } from '@ctb/engine';
import { describe, expect, it } from 'vitest';
import { backfillAll, parseBackfillFlags } from '../src/commands/backfill.js';
import { autoDepthLovelace, runIntervalSecFor, sweepSkipReason } from '../src/commands/backtest.js';
import { sweepRows } from '../src/compare.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const summary = (over: Partial<RunSummaryStats>): RunSummaryStats => ({
  candles: 4969, intents: 9, filled: 8, rejected: 1, startEquityLovelace: '1000000000', endEquityLovelace: '1044539376', returnPct: 4.45, maxDrawdownPct: 15.69,
  feesLovelace: '17600000', poolFeesIn: '0', rejectReasons: {}, coverage: { candles: 4969, first: null, last: null, expectedBuckets: 13242, maxGapMs: 0, gapsOverBound: 0 }, warnings: [], ...over,
});

describe('sweepRows', () => {
  it('one row per token x strategy in run order, with the run\'s own coverage and its depth', () => {
    const rows = sweepRows([
      { ticker: 'SNEK', strategyId: 'rsi-mean-reversion', runId: 12, summary: summary({}), depthAda: 812345.67 },
      { ticker: 'HOSKY', strategyId: 'buy-and-hold', runId: 13, summary: summary({ returnPct: -12.13, warnings: ['x'], coverage: { candles: 10, first: null, last: null, expectedBuckets: 0, maxGapMs: 0, gapsOverBound: 0 } }), depthAda: null },
    ]);
    expect(rows[0]).toEqual({ ticker: 'SNEK', strategy: 'rsi-mean-reversion', runId: 12, depthAda: 812345.67, coveragePct: '37.5', candles: 4969, returnPct: 4.45, maxDrawdownPct: 15.69, filled: 8, intents: 9, feesAda: '17.600000', warnings: 0 });
    expect(rows[1]).toMatchObject({ ticker: 'HOSKY', depthAda: '-', coveragePct: '0.0', warnings: 1 });
  });
});

describe('backfillAll', () => {
  it('runs tokens one at a time and turns a failing token into a failure row, not the end of the sweep', async () => {
    const order: string[] = [];
    const one = async (ticker: string) => {
      order.push(ticker);
      if (ticker === 'STUFF') throw new Error('no ADA pool on geckoterminal for STUFF');
      return { ticker, pool: 'p', method: 'identifier', pages: 1, newRows: 5, calls: 2, coverageFirst: '-', coverageLast: '-', coverageRows: 5 };
    };
    const r = await backfillAll([{ ticker: 'SNEK' }, { ticker: 'STUFF' }, { ticker: 'HOSKY' }], one, log);
    expect(order).toEqual(['SNEK', 'STUFF', 'HOSKY']);
    expect(r.rows.map((x) => x.ticker)).toEqual(['SNEK', 'HOSKY']);
    expect(r.failures).toEqual([{ ticker: 'STUFF', error: 'no ADA pool on geckoterminal for STUFF' }]);
  });
});

describe('autoDepthLovelace', () => {
  it('reads the max ADA reserve at the token\'s latest snapshot tick, as bigint, or null with no snapshot', async () => {
    const seen: unknown[] = [];
    const db = { query: async <T>(sql: string, params?: unknown[]) => { seen.push(params); return { rows: [{ reserve_quote: sql.includes('max(reserve_quote)') ? '52331970594' : null }] as T[] }; } };
    expect(await autoDepthLovelace(db, 'unit-1')).toBe(52_331_970_594n);
    expect(seen[0]).toEqual(['unit-1']);
    const empty = { query: async <T>() => ({ rows: [{ reserve_quote: null }] as T[] }) };
    expect(await autoDepthLovelace(empty, 'unit-2')).toBeNull();
  });

  it('parseBackfillFlags: --spacing-sec is optional, numeric, non-negative; unknown flags are refused', () => {
    expect(parseBackfillFlags([])).toEqual({ spacingSec: null });
    expect(parseBackfillFlags(['--spacing-sec', '8'])).toEqual({ spacingSec: 8 });
    expect(() => parseBackfillFlags(['--spacing-sec'])).toThrow(/non-negative number/);
    expect(() => parseBackfillFlags(['--spacing-sec', 'fast'])).toThrow(/non-negative number/);
    expect(() => parseBackfillFlags(['--bogus'])).toThrow(/unknown flag --bogus/);
  });

  it('runIntervalSecFor: external history is measured at its own 5-minute interval, local candles at the collector\'s', () => {
    expect(runIntervalSecFor('candles_external', 600)).toBe(300);
    expect(runIntervalSecFor('candles', 600)).toBe(600);
    expect(runIntervalSecFor('candles', 900)).toBe(900);
  });
  it('sweepSkipReason: no map, an empty window, or run', () => {
    expect(sweepSkipReason(false, 0)).toMatch(/run backfill first/);
    expect(sweepSkipReason(true, 0)).toMatch(/empty in this window/);
    expect(sweepSkipReason(true, 1)).toBeNull();
  });
});
