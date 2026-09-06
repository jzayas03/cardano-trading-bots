import { describe, expect, it } from 'vitest';
import { parsePaperArgs } from '../src/commands/paper.js';

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
