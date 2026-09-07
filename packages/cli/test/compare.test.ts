import { describe, expect, it } from 'vitest';
import type { RunSummaryStats } from '@ctb/engine';
import { compareRows } from '../src/compare.js';

const summary = (over: Partial<RunSummaryStats>): RunSummaryStats => ({
  candles: 100, intents: 4, filled: 3, rejected: 1, startEquityLovelace: '1000000000', endEquityLovelace: '1050000000', returnPct: 5, maxDrawdownPct: 2.5,
  feesLovelace: '6600000', poolFeesIn: '0', rejectReasons: {}, coverage: { candles: 100, first: null, last: null, expectedBuckets: 100, maxGapMs: 0, gapsOverBound: 0 },
  warnings: [], ...over,
});

describe('compareRows', () => {
  it('keeps the operator\'s order and copies the persisted summary numbers', () => {
    const rows = compareRows([
      { strategyId: 'ma-crossover', runId: 7, summary: summary({ returnPct: -1.25 }) },
      { strategyId: 'buy-and-hold', runId: 8, summary: summary({ returnPct: 9, warnings: ['never traded'] }) },
    ]);
    expect(rows.map((r) => r.strategy)).toEqual(['ma-crossover', 'buy-and-hold']);
    expect(rows[0]).toEqual({ strategy: 'ma-crossover', runId: 7, candles: 100, intents: 4, filled: 3, rejected: 1, returnPct: -1.25, maxDrawdownPct: 2.5, feesAda: '6.600000', warnings: 0 });
    expect(rows[1]?.warnings).toBe(1);
  });
  it('renders fees with the report\'s own exact ADA formatter, sign included', () => {
    expect(compareRows([{ strategyId: 's', runId: 1, summary: summary({ feesLovelace: '5000' }) }])[0]?.feesAda).toBe('0.005000');
    expect(compareRows([{ strategyId: 's', runId: 1, summary: summary({ feesLovelace: '-1500000' }) }])[0]?.feesAda).toBe('-1.500000');
  });
  it('is empty for no results', () => {
    expect(compareRows([])).toEqual([]);
  });
});
