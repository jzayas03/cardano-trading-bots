import { describe, expect, it } from 'vitest';
import type { RunCoverage } from '@ctb/engine';
import {
  BASELINE_STRATEGIES, MAX_GAPS_OVER_BOUND_PCT, MIN_COVERAGE_PCT, MIN_ROUND_TRIPS,
  promotionVerdict, type PromotionInput,
} from '../src/index.js';

const coverage = (over: Partial<RunCoverage> = {}): RunCoverage => ({
  candles: 100, first: null, last: null, expectedBuckets: 100, maxGapMs: 0, gapsOverBound: 0, ...over,
});
const input = (over: Partial<PromotionInput> = {}): PromotionInput => ({
  strategyId: 'ma-crossover',
  filledSells: 30, returnBasePct: 5,
  coverage: coverage(),
  baselines: [
    { strategyId: 'scheduled-accumulation', returnBasePct: 1 },
    { strategyId: 'buy-and-hold', returnBasePct: 2 },
  ],
  ...over,
});

describe('promotion gate', () => {
  it('promotes only a run that clears every criterion', () => {
    const v = promotionVerdict(input());
    expect(v.status).toBe('candidate');
    expect(v.blockers).toEqual([]);
    // Every check is reported even when it passes: a gate that only speaks when it fails cannot be
    // audited, and the founder signed off on thresholds they should be able to see applied.
    expect(v.checks.map((c) => c.id)).toEqual(['round-trips', 'coverage', 'measurable', 'beats-baselines']);
    expect(v.checks.every((c) => c.passed)).toBe(true);
  });

  it('bars on one round trip short of the threshold, and says the count', () => {
    expect(MIN_ROUND_TRIPS).toBe(30);
    const v = promotionVerdict(input({ filledSells: 29 }));
    expect(v.status).toBe('experimental');
    expect(v.blockers[0]).toMatch(/29 of 30 round trips/);
  });

  it('names a baseline strategy as such rather than as a failed candidate', () => {
    // The baselines never sell, so they have no round trips BY DESIGN. "0 of 30" would read as a
    // strategy falling far short of a bar it is not standing at.
    const v = promotionVerdict(input({ strategyId: 'scheduled-accumulation', filledSells: 0 }));
    expect(v.status).toBe('experimental');
    expect(v.blockers[0]).toMatch(/is a baseline, not a promotion candidate/);
    expect(v.blockers[0]).not.toMatch(/0 of 30/);
  });

  it('identifies a baseline by strategy, never by whether THIS run happened to sell', () => {
    // A ma-crossover run that has not sold yet is a candidate with zero round trips, not a baseline.
    // Keying on behaviour turned one run's luck into a claim about the strategy.
    const v = promotionVerdict(input({ strategyId: 'ma-crossover', filledSells: 0 }));
    expect(v.blockers[0]).toBe('0 of 30 round trips');
  });

  it('bars a run that did not see its own window', () => {
    expect(MIN_COVERAGE_PCT).toBe(80);
    const thin = promotionVerdict(input({ coverage: coverage({ candles: 70 }) }));
    expect(thin.blockers.some((b) => /coverage 70\.0%/.test(b))).toBe(true);
    expect(MAX_GAPS_OVER_BOUND_PCT).toBe(5);
    const gappy = promotionVerdict(input({ coverage: coverage({ gapsOverBound: 10 }) }));
    expect(gappy.blockers.some((b) => /10\.0% of candles/.test(b))).toBe(true);
    // A run predating coverage stats is not a passing run — absence is not evidence of a full window.
    const none = promotionVerdict(input({ coverage: undefined }));
    expect(none.blockers.some((b) => /coverage was not recorded/i.test(b))).toBe(true);
  });

  it('bars when a required baseline is missing, naming which', () => {
    expect(BASELINE_STRATEGIES).toEqual(['scheduled-accumulation', 'buy-and-hold']);
    const v = promotionVerdict(input({ baselines: [{ strategyId: 'buy-and-hold', returnBasePct: 2 }] }));
    expect(v.status).toBe('experimental');
    expect(v.blockers.some((b) => /scheduled-accumulation/.test(b))).toBe(true);
  });

  it('requires beating each baseline STRICTLY — a tie is not an edge', () => {
    const tie = promotionVerdict(input({ returnBasePct: 2 }));
    expect(tie.status).toBe('experimental');
    expect(tie.blockers.some((b) => /buy-and-hold/.test(b))).toBe(true);
    const beats = promotionVerdict(input({ returnBasePct: 2.01 }));
    expect(beats.status).toBe('candidate');
  });

  it('bars on an unmeasurable return rather than treating null as zero', () => {
    expect(promotionVerdict(input({ returnBasePct: null })).blockers.some((b) => /not measurable/i.test(b))).toBe(true);
    const badBaseline = promotionVerdict(input({
      baselines: [
        { strategyId: 'scheduled-accumulation', returnBasePct: null },
        { strategyId: 'buy-and-hold', returnBasePct: 2 },
      ],
    }));
    expect(badBaseline.status).toBe('experimental');
    expect(badBaseline.blockers.some((b) => /scheduled-accumulation/.test(b))).toBe(true);
  });

  it('reports every blocker, not just the first, so one fix does not reveal another', () => {
    const v = promotionVerdict(input({ filledSells: 2, returnBasePct: 0, coverage: coverage({ candles: 10 }) }));
    expect(v.blockers.length).toBeGreaterThanOrEqual(3);
  });
});
