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
});
