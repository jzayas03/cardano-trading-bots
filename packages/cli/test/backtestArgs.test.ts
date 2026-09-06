import { describe, expect, it } from 'vitest';
import { parseBacktestArgs } from '../src/commands/backtest.js';

describe('parseBacktestArgs', () => {
  it('parses positionals, defaults, and params', () => {
    const a = parseBacktestArgs(['ma-crossover', 'SNEK', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '--param', 'fast=6', '--param', 'slow=24']);
    expect(a).toMatchObject({ strategyId: 'ma-crossover', ticker: 'SNEK', source: 'candles', cashAda: 1000, depthAda: null, params: { fast: 6, slow: 24 } });
    expect(a.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
  it('requires --depth-ada for the external source and forbids it otherwise', () => {
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--source', 'external'])).toThrow(/--depth-ada is required/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--depth-ada', '5000'])).toThrow(/--depth-ada only applies/);
    expect(parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--source', 'external', '--depth-ada', '5000']).depthAda).toBe(5000);
  });
  it('rejects bad dates, empty windows, non-numeric params, unknown flags', () => {
    expect(() => parseBacktestArgs(['s', 'T', 'soon', '2026-09-01'])).toThrow(/from/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-09-01', '2026-08-01'])).toThrow(/before/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--param', 'fast=quick'])).toThrow(/numeric/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--bogus'])).toThrow(/unknown flag --bogus/);
  });
  // Finding C3: the stale-fill bound is a run parameter, with a default that must be visible.
  it('defaults the stale-fill bound to 15 minutes and accepts an override', () => {
    expect(parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01']).maxGapMin).toBe(15);
    expect(parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--max-gap-min', '60']).maxGapMin).toBe(60);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--max-gap-min', '0'])).toThrow(/positive number of minutes/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--max-gap-min', 'soon'])).toThrow(/--max-gap-min/);
  });

  it('rejects --param with an empty value or an empty key (Number(\'\') is 0, not a valid numeric value)', () => {
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--param', 'fast='])).toThrow(/numeric/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--param', '=5'])).toThrow(/numeric/);
  });
});
