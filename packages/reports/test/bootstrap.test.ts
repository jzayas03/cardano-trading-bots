import { describe, expect, it } from 'vitest';
import { bcaInterval, bcaStability, BOOTSTRAP_RESAMPLES, conservativeBounds, mean, STABILITY_TOLERANCE } from '../src/index.js';

/** Deterministic pseudo-sample, so these tests never depend on a global RNG. */
const sample = (n: number, f: (i: number) => number): number[] => Array.from({ length: n }, (_, i) => f(i));
/** Roughly symmetric around 100, spread ±60. */
const symmetric = sample(60, (i) => 100 + ((i % 13) - 6) * 10);
/** Same centre, a long right tail — the shape BCa exists to handle. */
const skewed = [...sample(55, (i) => 100 + ((i % 7) - 3) * 5), 900, 1100, 1400, 2000, 2600];

describe('BCa bootstrap', () => {
  it('brackets the estimate and reports the corrections that produced the interval', () => {
    const r = bcaInterval(symmetric, mean, { seed: 1 })!;
    expect(r.estimate).toBeCloseTo(mean(symmetric), 6);
    expect(r.lower).toBeLessThan(r.estimate);
    expect(r.upper).toBeGreaterThan(r.estimate);
    expect(r.level).toBe(0.95);
    expect(r.resamples).toBe(BOOTSTRAP_RESAMPLES);
    expect(BOOTSTRAP_RESAMPLES).toBeGreaterThanOrEqual(1000); // the reviewed floor
    // Reported so a degenerate fit is visible rather than silently producing a plausible interval.
    expect(Number.isFinite(r.z0)).toBe(true);
    expect(Number.isFinite(r.acceleration)).toBe(true);
    expect(r.degenerate).toBe(false);
  });

  it('is deterministic for a seed, and only for a seed', () => {
    const a = bcaInterval(symmetric, mean, { seed: 7 })!;
    const b = bcaInterval(symmetric, mean, { seed: 7 })!;
    expect([a.lower, a.upper]).toEqual([b.lower, b.upper]);
    const c = bcaInterval(symmetric, mean, { seed: 8 })!;
    expect([c.lower, c.upper]).not.toEqual([a.lower, a.upper]);
  });

  it('CORRECTS a skewed sample away from the plain percentile interval', () => {
    // The whole reason for BCa. On a right-skewed sample the percentile interval is centred on the
    // resample distribution; BCa shifts it using z0 and the jackknife acceleration. If these two
    // ever coincide on THIS sample, the correction has stopped being applied.
    const r = bcaInterval(skewed, mean, { seed: 3 })!;
    expect(Math.abs(r.acceleration)).toBeGreaterThan(0.01);
    const shifted = Math.abs(r.lower - r.percentileLower) + Math.abs(r.upper - r.percentileUpper);
    expect(shifted).toBeGreaterThan(0);
  });

  it('holds its bounds across seeds at the default resample count', () => {
    // The convergence check the review asks for: rerun with another seed and confirm the bounds do
    // not move. Expressed as a FRACTION OF INTERVAL WIDTH, so it means the same thing whatever the
    // statistic's units are.
    const s = bcaStability(symmetric, mean, { seeds: [1, 2, 3] })!;
    expect(s.maxBoundShiftFraction).toBeLessThan(STABILITY_TOLERANCE);
    expect(s.stable).toBe(true);
  });

  it('flags instability rather than hiding it when the resample count is too low', () => {
    const s = bcaStability(skewed, mean, { seeds: [1, 2, 3, 4], resamples: 40 })!;
    expect(s.stable).toBe(false);
    expect(s.maxBoundShiftFraction).toBeGreaterThan(STABILITY_TOLERANCE);
  });

  it('covers a known mean on a large sample', () => {
    const big = sample(400, (i) => 50 + ((i * 37) % 101) - 50);
    const r = bcaInterval(big, mean, { seed: 11 })!;
    expect(r.lower).toBeLessThan(mean(big));
    expect(r.upper).toBeGreaterThan(mean(big));
    // A 400-sample interval on this spread should be narrow; a wide one means the resampling broke.
    expect(r.upper - r.lower).toBeLessThan(20);
  });

  it('degenerates honestly on a constant sample instead of inventing a spread', () => {
    const r = bcaInterval(sample(30, () => 42), mean, { seed: 1 })!;
    expect(r.degenerate).toBe(true);
    expect(r.lower).toBe(42);
    expect(r.upper).toBe(42);
  });

  it('is null below the sample size a jackknife needs, rather than returning a point', () => {
    expect(bcaInterval([], mean, { seed: 1 })).toBeNull();
    expect(bcaInterval([5], mean, { seed: 1 })).toBeNull();
    expect(bcaStability([5], mean, { seeds: [1, 2] })).toBeNull();
  });

  it('takes the WIDEST of the two intervals for a decision, and reports how far they disagree', () => {
    // Neither method dominates across the shapes we might be in (see the coverage table in
    // bootstrap.ts), and both under-cover at n = 30. A gate whose job is to refuse takes the bound
    // that makes promotion harder rather than picking a winner the evidence does not support.
    const r = bcaInterval(skewed, mean, { seed: 3 })!;
    const c = conservativeBounds(r);
    expect(c.lower).toBeLessThanOrEqual(Math.min(r.lower, r.percentileLower));
    expect(c.upper).toBeGreaterThanOrEqual(Math.max(r.upper, r.percentileUpper));
    expect(c.upper - c.lower).toBeGreaterThanOrEqual(r.upper - r.lower);
    // On a skewed sample the two methods must actually differ, or the correction is not applying.
    expect(c.methodsDisagreeBy).toBeGreaterThan(0);
    // On a symmetric one they should nearly coincide, so the conservative bound costs almost nothing.
    expect(conservativeBounds(bcaInterval(symmetric, mean, { seed: 3 })!).methodsDisagreeBy).toBeLessThan(0.5);
  });

  it('works on any statistic, not just the mean', () => {
    const median = (xs: readonly number[]): number => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
    };
    const r = bcaInterval(skewed, median, { seed: 5 })!;
    expect(r.estimate).toBe(median(skewed));
    expect(r.lower).toBeLessThanOrEqual(r.estimate);
    expect(r.upper).toBeGreaterThanOrEqual(r.estimate);
  });
});
