import { describe, expect, it } from 'vitest';
import { parseBacktestArgs, parseStrategyList } from '../src/commands/backtest.js';

describe('parseBacktestArgs', () => {
  it('parses positionals, defaults, and params', () => {
    const a = parseBacktestArgs(['ma-crossover', 'SNEK', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '--param', 'fast=6', '--param', 'slow=24']);
    expect(a).toMatchObject({ strategyIds: ['ma-crossover'], ticker: 'SNEK', source: 'candles', cashAda: 1000, depthAda: null, params: { fast: 6, slow: 24 }, syntheticPrice: 'close' });
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

  // Finding M7: `'fast=1=2'.split('=')` destructures to ['fast', '1'], so a typo silently changed
  // the run to fast=1 instead of stopping it. Split on the first '=' only; the rest is the value,
  // and a value containing '=' is not numeric, so it is rejected.
  it('splits --param on the first = only and rejects a value containing another one', () => {
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--param', 'fast=1=2'])).toThrow(/numeric/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--param', 'fast'])).toThrow(/numeric/);
    // A negative value still parses: the '=' split must not swallow the sign.
    expect(parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--param', 'drift=-1.5']).params.drift).toBe(-1.5);
  });

  // Plan 3 Task 3: worst-of synthetic pricing is opt-in and only means anything for the synthetic
  // fill model. Defaulting to 'close' keeps every existing backtest identical.
  it('defaults --synthetic-price to close, accepts worst for the external source, and forbids it otherwise', () => {
    expect(parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01']).syntheticPrice).toBe('close');
    expect(parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--source', 'external', '--depth-ada', '5000', '--synthetic-price', 'worst']).syntheticPrice).toBe('worst');
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--synthetic-price', 'worst'])).toThrow(/--synthetic-price only applies/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--source', 'external', '--depth-ada', '5000', '--synthetic-price', 'bogus'])).toThrow(/--synthetic-price must be/);
  });

  // A comma list runs several strategies over one window. Fewer than typed is refused, not dropped.
  it('accepts a comma-separated strategy list and refuses empty or repeated ids', () => {
    expect(parseBacktestArgs(['ma-crossover,rsi-mean-reversion, buy-and-hold', 'T', '2026-08-01', '2026-09-01']).strategyIds).toEqual(['ma-crossover', 'rsi-mean-reversion', 'buy-and-hold']);
    expect(parseStrategyList('a')).toEqual(['a']);
    expect(() => parseStrategyList('a,,b')).toThrow(/empty strategy id/);
    expect(() => parseStrategyList('a,b,')).toThrow(/empty strategy id/);
    expect(() => parseStrategyList('a,b,a')).toThrow(/listed more than once/);
  });

  // ALL = every token; depth defaults to auto there because one hand-typed depth cannot fit 20 tokens.
  it('ALL with the external source defaults --depth-ada to auto; a single ticker still requires it; auto parses explicitly', () => {
    expect(parseBacktestArgs(['s', 'ALL', '2026-06-01', '2026-09-01', '--source', 'external'])).toMatchObject({ ticker: 'ALL', depthAda: 'auto' });
    expect(parseBacktestArgs(['s', 'SNEK', '2026-06-01', '2026-09-01', '--source', 'external', '--depth-ada', 'auto']).depthAda).toBe('auto');
    expect(parseBacktestArgs(['s', 'ALL', '2026-06-01', '2026-09-01', '--source', 'external', '--depth-ada', '500']).depthAda).toBe(500);
    expect(() => parseBacktestArgs(['s', 'SNEK', '2026-06-01', '2026-09-01', '--source', 'external'])).toThrow(/--depth-ada is required/);
    expect(() => parseBacktestArgs(['s', 'ALL', '2026-06-01', '2026-09-01', '--depth-ada', 'auto'])).toThrow(/--depth-ada only applies/);
    expect(parseBacktestArgs(['s', 'ALL', '2026-06-01', '2026-09-01']).depthAda).toBeNull();
  });
});
