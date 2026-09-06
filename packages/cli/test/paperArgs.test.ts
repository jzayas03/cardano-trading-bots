import { describe, expect, it } from 'vitest';
import { paramsMismatch, parsePaperArgs } from '../src/commands/paper.js';

describe('parsePaperArgs', () => {
  it('defaults cashAda, intervalSec, graceSec, maxGapMin, rehearsal, and resume', () => {
    const a = parsePaperArgs(['ma-crossover', 'SNEK']);
    expect(a).toEqual({
      strategyId: 'ma-crossover', ticker: 'SNEK', cashAda: 1000, resume: null,
      intervalSec: 300, graceSec: 60, maxGapMin: 15, rehearsal: false, params: {},
    });
  });

  it('parses --resume', () => {
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--resume', '12']).resume).toBe(12);
  });

  it('parses --rehearsal', () => {
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--rehearsal']).rehearsal).toBe(true);
  });

  it('rejects --interval-sec below 60', () => {
    expect(() => parsePaperArgs(['ma-crossover', 'SNEK', '--interval-sec', '10'])).toThrow(/--interval-sec needs a number >= 60/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parsePaperArgs(['ma-crossover', 'SNEK', '--bogus'])).toThrow(/unknown flag --bogus/);
  });

  it('rejects an empty --param value', () => {
    expect(() => parsePaperArgs(['ma-crossover', 'SNEK', '--param', ''])).toThrow(/--param needs key=numeric value/);
    expect(() => parsePaperArgs(['ma-crossover', 'SNEK', '--param'])).toThrow(/--param needs key=numeric value/);
  });

  it('parses --param key=value pairs', () => {
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--param', 'fast=6']).params).toEqual({ fast: 6 });
  });
});

/**
 * Finding F2: `--resume` restored a prior run's cash/position but never checked whether the strategy
 * params it's about to run with are the ones the prior run was started with — a resumed run silently
 * splicing a different `slow`/`fast` etc. onto an equity curve started under the old ones. `current` is
 * `{ ...strategy.defaultParams, ...a.params }` (the same merge `runEngine` itself does); `prior` is the
 * jsonb `runs.params` blob, which flattens strategy params at the top level next to `cashAda`/`maxGapMs`
 * (see `buildRunParams`) — so this compares `current`'s own keys against that same top level.
 */
describe('paramsMismatch', () => {
  it('returns null when every key present in prior matches current', () => {
    expect(paramsMismatch({ fast: 6, slow: 20, cashAda: 1000 }, { fast: 6, slow: 20 })).toBeNull();
  });

  it('names the mismatched key and both values', () => {
    const msg = paramsMismatch({ fast: 6, slow: 20 }, { fast: 6, slow: 25 });
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/slow/);
    expect(msg).toContain('20');
    expect(msg).toContain('25');
  });

  it('ignores a current key the prior run never recorded', () => {
    expect(paramsMismatch({ fast: 6 }, { fast: 6, slow: 25 })).toBeNull();
  });

  it('compares numerically: a jsonb string value equal in number to current is not a mismatch', () => {
    expect(paramsMismatch({ fast: '6' }, { fast: 6 })).toBeNull();
  });
});
