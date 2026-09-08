import { describe, expect, it } from 'vitest';
import {
  changesOf, crossCorrelation, interpret, MIN_SAMPLE, pearson, returnsOf, significanceThreshold,
} from '../src/leadlag.js';

describe('pearson', () => {
  it('is 1 and -1 for perfect relationships', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
  });

  it('returns NULL, not 0, for a flat series', () => {
    // 0 would claim "no relationship". The truth is the question does not apply, and a caller that
    // treats "undefined" as "uncorrelated" will happily report a flat stablecoin as a clean signal.
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull();
    expect(pearson([1, 2, 3, 4], [5, 5, 5, 5])).toBeNull();
  });

  it('returns null below three points rather than a meaningless 1', () => {
    expect(pearson([1, 2], [3, 4])).toBeNull();
  });
});

describe('crossCorrelation', () => {
  // A single, non-repeating spike. My first fixture used TWO spikes six apart and it aliased: lag
  // +2 and lag -4 both aligned perfectly and the tie went to the lower lag. That is not a quirk of
  // the test — periodic structure aliases across lags in real data too, which is one more reason a
  // peak alone is not evidence.
  it('finds a POSITIVE lag when structure leads price', () => {
    const structure = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    const returns   = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
    const best = crossCorrelation(structure, returns, 4).reduce((a, b) => (Math.abs(b.r) > Math.abs(a.r) ? b : a));
    expect(best.lag).toBe(2);
    expect(best.r).toBeGreaterThan(0.9);
  });

  it('finds a NEGATIVE lag when price leads — the echo case', () => {
    const returns   = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    const structure = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
    const best = crossCorrelation(structure, returns, 4).reduce((a, b) => (Math.abs(b.r) > Math.abs(a.r) ? b : a));
    expect(best.lag).toBe(-2);
  });

  it('an aliased signal peaks at more than one lag, which is why a peak is not proof', () => {
    const structure = [0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    const returns   = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
    const perfect = crossCorrelation(structure, returns, 4).filter((c) => c.r > 0.99);
    expect(perfect.length).toBeGreaterThan(1);
    expect(perfect.map((c) => c.lag)).toContain(2);
  });

  it('reports the shrinking sample at larger lags', () => {
    const r = crossCorrelation([1, 2, 3, 4, 5, 6], [2, 1, 4, 3, 6, 5], 2);
    expect(r.find((x) => x.lag === 0)!.n).toBe(6);
    expect(r.find((x) => x.lag === 2)!.n).toBe(4);
  });
});

describe('significanceThreshold', () => {
  it('widens with the number of comparisons, not just the sample', () => {
    // The whole point: the largest of 13 draws clears the one-test bar by chance.
    const one = significanceThreshold(400, 1);
    const many = significanceThreshold(400, 13);
    expect(many).toBeGreaterThan(one);
    expect(one).toBeCloseTo(0.1, 2);
  });

  it('is unreachable for a sample too small to say anything', () => {
    expect(significanceThreshold(2, 1)).toBe(Infinity);
  });
});

describe('interpret', () => {
  const many = (r: number, lag: number, n: number) => [{ lag, r, n }];

  it('says UNDERPOWERED rather than giving a number, when the sample is thin', () => {
    // The failure this exists to prevent: 115 candles per token produce a confident wrong answer,
    // not a weak one.
    const v = interpret(many(0.95, 3, 115), 13);
    expect(v.kind).toBe('underpowered');
    if (v.kind === 'underpowered') { expect(v.n).toBe(115); expect(v.needed).toBe(MIN_SAMPLE); }
  });

  it('rejects a correlation that does not clear the multiple-testing bar', () => {
    expect(interpret(many(0.12, 3, 400), 13).kind).toBe('no signal');
  });

  it('separates a tradeable lead from an untradeable coincidence', () => {
    expect(interpret(many(0.6, 3, 400), 13).kind).toBe('structure leads');
    expect(interpret(many(0.6, 0, 400), 13).kind).toBe('contemporaneous');
    expect(interpret(many(0.6, -3, 400), 13).kind).toBe('price leads');
  });

  it('handles an empty result set as underpowered, never as no-signal', () => {
    expect(interpret([], 13).kind).toBe('underpowered');
  });
});

describe('returnsOf / changesOf', () => {
  it('is one shorter than its input and survives a zero', () => {
    const r = returnsOf([100, 110, 99]);
    expect(r).toHaveLength(2);
    // toBeCloseTo, not toEqual: 99/110 - 1 is -0.09999999999999998, and pinning a float literal
    // tests the arithmetic of the machine rather than the behaviour of the function.
    expect(r[0]!).toBeCloseTo(0.1, 12);
    expect(r[1]!).toBeCloseTo(-0.1, 12);
    expect(returnsOf([0, 5])).toEqual([0]);      // a zero base yields 0, never Infinity
    expect(changesOf([2, 4])).toEqual([1]);
    expect(returnsOf([5])).toEqual([]);
  });
});
