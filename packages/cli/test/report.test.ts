import { describe, expect, it } from 'vitest';
import { adaStr, coverageLine } from '../src/commands/report.js';

/**
 * Finding M10: `adaStr` went through `Number(BigInt(x)) / 1e6`, which stops being exact above 2^53
 * lovelace (~9.007 billion ADA) and, well before that, prints an approximation of a figure the whole
 * report exists to make exact. Integer part and six fractional digits, in bigint.
 */
describe('adaStr', () => {
  it('formats whole and fractional lovelace exactly', () => {
    expect(adaStr(0n)).toBe('0.000000');
    expect(adaStr(1n)).toBe('0.000001');
    expect(adaStr(2_200_000n)).toBe('2.200000');
    expect(adaStr('1000000000')).toBe('1000.000000');
    expect(adaStr(999_999n)).toBe('0.999999');
  });

  it('stays exact past 2^53 lovelace, where the float path silently rounded', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1: Number() cannot represent this
    expect(adaStr(big)).toBe('9007199254.740993');
    expect(adaStr(big)).not.toBe((Number(big) / 1_000_000).toFixed(6));
  });

  it('keeps the sign on a negative balance', () => {
    expect(adaStr(-2_200_000n)).toBe('-2.200000');
    expect(adaStr(-1n)).toBe('-0.000001');
  });
});

/** Finding C3: the coverage header is where a sparse window stops being invisible. */
describe('coverageLine', () => {
  it('states how much of the window the run actually saw', () => {
    const line = coverageLine({ candles: 4400, first: '2026-06-01T00:00:00.000Z', last: '2026-09-01T00:00:00.000Z', expectedBuckets: 26_496, maxGapMs: 26_700_000, gapsOverBound: 561 });
    expect(line).toContain('4400 of 26496 expected buckets (16.6%)');
    expect(line).toContain('max gap 445m');
    expect(line).toContain('561 gaps over the stale-fill bound');
  });

  it('says so rather than dividing by zero on an empty window', () => {
    expect(coverageLine({ candles: 0, first: null, last: null, expectedBuckets: 0, maxGapMs: 0, gapsOverBound: 0 })).toContain('empty window');
  });

  it('names a run that predates coverage instead of printing blanks', () => {
    expect(coverageLine(undefined)).toMatch(/not recorded/);
  });
});
