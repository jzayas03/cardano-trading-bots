import type { RunSummaryStats } from '@ctb/engine';
import { describe, expect, it } from 'vitest';
import { parseBacktestArgs } from '../src/commands/backtest.js';
import { gridCombinations, gridRows, gridWarning, parseGridArg } from '../src/grid.js';

describe('parseGridArg', () => {
  it('parses key=v1,v2 and accumulates axes in order', () => {
    const g = parseGridArg('slow=24,48,96', parseGridArg('fast=6,12', {}));
    expect(Object.keys(g)).toEqual(['fast', 'slow']);
    expect(g).toEqual({ fast: [6, 12], slow: [24, 48, 96] });
  });
  it('refuses a missing value, a non-number, an empty item, a repeated value, and a repeated axis', () => {
    expect(() => parseGridArg(undefined, {})).toThrow(/--grid needs key=v1,v2/);
    expect(() => parseGridArg('fast', {})).toThrow(/--grid needs key=v1,v2/);
    expect(() => parseGridArg('fast=6,quick', {})).toThrow(/"quick" is not a number/);
    expect(() => parseGridArg('fast=6,,12', {})).toThrow(/is not a number/);
    expect(() => parseGridArg('fast=6,6', {})).toThrow(/6 listed more than once/);
    expect(() => parseGridArg('fast=6', { fast: [1] })).toThrow(/given more than once/);
  });
});

describe('gridCombinations', () => {
  it('is the Cartesian product, first axis slowest-varying, and one empty combo with no grid', () => {
    expect(gridCombinations({})).toEqual([{}]);
    expect(gridCombinations({ fast: [6, 12], slow: [24, 48, 96] })).toEqual([
      { fast: 6, slow: 24 }, { fast: 6, slow: 48 }, { fast: 6, slow: 96 }, { fast: 12, slow: 24 }, { fast: 12, slow: 48 }, { fast: 12, slow: 96 },
    ]);
  });
});

describe('gridRows + gridWarning', () => {
  const summary = (returnPct: number): RunSummaryStats => ({
    candles: 10, intents: 2, filled: 1, rejected: 1, startEquityLovelace: '1000000000', endEquityLovelace: '1000000000', returnPct, maxDrawdownPct: 1,
    feesLovelace: '2200000', poolFeesIn: '0', rejectReasons: {}, coverage: { candles: 10, first: null, last: null, expectedBuckets: 10, maxGapMs: 0, gapsOverBound: 0 }, warnings: [],
  });
  it('keeps run order (never sorts by return) and names the combination', () => {
    const rows = gridRows([{ combo: { fast: 6, slow: 24 }, runId: 1, summary: summary(-2) }, { combo: { fast: 12, slow: 24 }, runId: 2, summary: summary(9) }]);
    expect(rows.map((r) => [r.runId, r.params, r.returnPct])).toEqual([[1, 'fast=6 slow=24', -2], [2, 'fast=12 slow=24', 9]]);
    expect(rows[0]?.feesAda).toBe('2.200000');
  });
  it('the warning names the count and the selection bias', () => {
    expect(gridWarning(6, 'w')).toMatch(/6 parameter combinations were tried on the same window \(w\); the best of them is optimistic by construction/);
  });
});

describe('parseBacktestArgs --grid', () => {
  it('accepts repeated --grid with one strategy and one ticker; refuses a strategy list, ALL, and a --param that is also an axis', () => {
    const a = parseBacktestArgs(['ma-crossover', 'SNEK', '2026-06-01', '2026-09-01', '--grid', 'fast=6,12', '--grid', 'slow=24,48', '--param', 'fraction=0.5']);
    expect(a.grid).toEqual({ fast: [6, 12], slow: [24, 48] });
    expect(a.params).toEqual({ fraction: 0.5 });
    expect(parseBacktestArgs(['s', 'T', '2026-06-01', '2026-09-01']).grid).toEqual({});
    expect(() => parseBacktestArgs(['a,b', 'SNEK', '2026-06-01', '2026-09-01', '--grid', 'fast=6,12'])).toThrow(/--grid runs one strategy/);
    expect(() => parseBacktestArgs(['a', 'ALL', '2026-06-01', '2026-09-01', '--grid', 'fast=6,12'])).toThrow(/--grid runs one ticker/);
    expect(() => parseBacktestArgs(['a', 'SNEK', '2026-06-01', '2026-09-01', '--grid', 'fast=6,12', '--param', 'fast=3'])).toThrow(/both a --param and a --grid axis/);
  });
});
