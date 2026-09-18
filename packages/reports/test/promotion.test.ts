import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EquityPoint, RunCoverage } from '@ctb/engine';
import {
  BASELINE_STRATEGIES, exposureAdjusted, MAX_CAPITAL_DRIFT, MAX_GAPS_OVER_BOUND_PCT, MIN_COVERAGE_PCT,
  MIN_TRIPS_FOR_INTERVAL, MIN_WINDOW_OVERLAP, promotionVerdict, type PromotionInput, type RunContext,
} from '../src/index.js';

/** Twelve trips, every one strongly positive after costs. Unambiguous evidence at a small n. */
const STRONG_EDGE = Array.from({ length: 12 }, (_, i) => 300 + ((i % 5) - 2) * 20);
/** Thirty trips averaging barely positive with a wide spread: the interval must span zero.
 * This input PASSES the count check this gate used to apply.
 *
 * Written out rather than generated from `i % k`: a periodic fixture interacts with the block
 * resampler's `n^(1/3)` block length and lands on the stability boundary, which refuses the input
 * for the wrong reason. Found by this test on 2026-09-17. */
const MEDIOCRE_30 = [
  -180, 240, -95, 60, 15, -220, 130, -40, 75, -160,
  200, -55, 20, 95, -130, 45, -75, 165, -210, 110,
  -30, 85, -145, 55, 35, -100, 190, -65, 25, 70,
];
/** Eleven losses and one huge win. Mean is positive; the evidence is one draw. */
const ONE_WINNER = [...Array.from({ length: 11 }, () => -50), 900];

const coverage = (over: Partial<RunCoverage> = {}): RunCoverage => ({
  candles: 100, first: null, last: null, expectedBuckets: 100, maxGapMs: 0, gapsOverBound: 0, ...over,
});
const WINDOW_FROM = Date.UTC(2026, 8, 9);
const WINDOW_TO = Date.UTC(2026, 8, 16);
const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  baseUnit: 'NIGHTunit', windowFromMs: WINDOW_FROM, windowToMs: WINDOW_TO,
  startEquityLovelace: 1_000_000_000n, ...over,
});
const input = (over: Partial<PromotionInput> = {}): PromotionInput => ({
  strategyId: 'ma-crossover',
  context: ctx(),
  filledSells: 30, roundTripReturnsBps: STRONG_EDGE, returnBasePct: 5,
  coverage: coverage(),
  baselines: [
    { strategyId: 'scheduled-accumulation', returnBasePct: 1, context: ctx() },
    { strategyId: 'buy-and-hold', returnBasePct: 2, context: ctx() },
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
    expect(v.checks.map((c) => c.id)).toEqual(['round-trips', 'coverage', 'comparable', 'measurable', 'beats-baselines']);
    expect(v.checks.every((c) => c.passed)).toBe(true);
  });

  it('bars one trip short of the minimum, says the count, and reports NO interval', () => {
    expect(MIN_TRIPS_FOR_INTERVAL).toBe(12);
    const v = promotionVerdict(input({ roundTripReturnsBps: STRONG_EDGE.slice(0, 11) }));
    expect(v.status).toBe('experimental');
    expect(v.blockers[0]).toMatch(/11 of 12 round trips/);
    // An interval computed below the minimum would read as evidence. Absence is the signal.
    expect(v.blockers[0]).not.toMatch(/\[/);
  });

  it('names a baseline strategy as such rather than as a failed candidate', () => {
    // The baselines never sell, so they have no round trips BY DESIGN. "0 of 30" would read as a
    // strategy falling far short of a bar it is not standing at.
    const v = promotionVerdict(input({ strategyId: 'scheduled-accumulation', roundTripReturnsBps: [] }));
    expect(v.status).toBe('experimental');
    expect(v.blockers[0]).toMatch(/is a baseline, not a promotion candidate/);
    expect(v.blockers[0]).not.toMatch(/0 of 12/);
  });

  it('identifies a baseline by strategy, never by whether THIS run happened to sell', () => {
    // A ma-crossover run that has not sold yet is a candidate with zero round trips, not a baseline.
    // Keying on behaviour turned one run's luck into a claim about the strategy.
    const v = promotionVerdict(input({ strategyId: 'ma-crossover', roundTripReturnsBps: [] }));
    expect(v.blockers[0]).toMatch(/^0 of 12 round trips/);
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

  it('bars a baseline that traded a DIFFERENT TOKEN, however good the number looks', () => {
    // The hole this closes: the gate took "the other runs in this comparison" on trust, so a
    // strategy could clear it against a comparator that never traded the same asset.
    const v = promotionVerdict(input({
      baselines: [
        { strategyId: 'scheduled-accumulation', returnBasePct: 1, context: ctx({ baseUnit: 'SNEKunit' }) },
        { strategyId: 'buy-and-hold', returnBasePct: 2, context: ctx() },
      ],
    }));
    expect(v.status).toBe('experimental');
    expect(v.blockers.some((b) => /scheduled-accumulation traded a different token/.test(b))).toBe(true);
  });

  it('bars a baseline measured over a different window', () => {
    expect(MIN_WINDOW_OVERLAP).toBe(0.95);
    const shifted = ctx({ windowFromMs: WINDOW_FROM + 86_400_000 * 3, windowToMs: WINDOW_TO + 86_400_000 * 3 });
    const v = promotionVerdict(input({
      baselines: [
        { strategyId: 'scheduled-accumulation', returnBasePct: 1, context: shifted },
        { strategyId: 'buy-and-hold', returnBasePct: 2, context: ctx() },
      ],
    }));
    expect(v.blockers.some((b) => /overlaps only/.test(b))).toBe(true);
    // A few minutes' difference in start time is normal and must NOT bar.
    const nudged = ctx({ windowFromMs: WINDOW_FROM + 600_000 });
    expect(promotionVerdict(input({
      baselines: [
        { strategyId: 'scheduled-accumulation', returnBasePct: 1, context: nudged },
        { strategyId: 'buy-and-hold', returnBasePct: 2, context: ctx() },
      ],
    })).status).toBe('candidate');
  });

  it('bars a baseline that started with materially different capital', () => {
    // Costs are largely FIXED per order, so more capital is a lower cost floor on the same trade.
    expect(MAX_CAPITAL_DRIFT).toBe(0.01);
    const rich = ctx({ startEquityLovelace: 2_000_000_000n });
    const v = promotionVerdict(input({
      baselines: [
        { strategyId: 'scheduled-accumulation', returnBasePct: 1, context: rich },
        { strategyId: 'buy-and-hold', returnBasePct: 2, context: ctx() },
      ],
    }));
    expect(v.blockers.some((b) => /different capital/.test(b))).toBe(true);
  });

  it('bars when conditions were not recorded at all, on either side', () => {
    expect(promotionVerdict(input({ context: undefined })).blockers.some((b) => /own run conditions were not recorded/.test(b))).toBe(true);
    const v = promotionVerdict(input({
      baselines: [
        { strategyId: 'scheduled-accumulation', returnBasePct: 1 },
        { strategyId: 'buy-and-hold', returnBasePct: 2, context: ctx() },
      ],
    }));
    expect(v.blockers.some((b) => /scheduled-accumulation's run conditions were not recorded/.test(b))).toBe(true);
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
    const v = promotionVerdict(input({ roundTripReturnsBps: [1, 2], returnBasePct: 0, coverage: coverage({ candles: 10 }) }));
    expect(v.blockers.length).toBeGreaterThanOrEqual(3);
  });

  // ---- specs/003: the gate measures evidence instead of counting -------------------------------

  it('POSITIVE CONTROL: a large consistent edge passes on TWELVE trips, far short of the old thirty', () => {
    const v = promotionVerdict(input({ roundTripReturnsBps: STRONG_EDGE }));
    const check = v.checks.find((c) => c.id === 'round-trips')!;
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/12 round trips/);
    expect(check.detail).toMatch(/\[/); // the interval is reported
  });

  it('NEGATIVE CONTROL: thirty mediocre trips FAIL, and that same input PASSES a count of thirty', () => {
    // This is the load-bearing test of specs/003. The old check was `filledSells >= 30`, which this
    // input satisfies exactly. If this ever goes green by PASSING, the gate has been relaxed rather
    // than re-specified, which is the failure the constitution names as most damaging.
    expect(MEDIOCRE_30).toHaveLength(30);
    const v = promotionVerdict(input({ roundTripReturnsBps: MEDIOCRE_30 }));
    const check = v.checks.find((c) => c.id === 'round-trips')!;
    expect(check.passed).toBe(false);
    // It must NOT be refused for having too few trips -- it has thirty. Which of the two
    // "enough trips" refusals fires is an implementation detail; that it refuses is the contract.
    expect(check.detail).not.toMatch(/too few/);
  });

  it('a STABLE interval that spans zero fails on the interval, not on stability', () => {
    // The mediocre-30 series above is refused as a seed artefact, which is correct but leaves the
    // interval branch untested. Reaching a STABLE interval that still straddles zero took n = 60:
    // at n = 30 a near-zero mean with any real spread moves more than 5% of its width between
    // seeds, which is `bootstrap.ts`'s own finding about this sample size arriving from the other
    // direction. Sixty mirrored observations, mean exactly zero, shift 1.6%.
    const half = [-15, 8, 2, -7, 17, -12, 1, 6, -10, 11, -4, 4, -18, 7, 0, 9, -9, 3, -3, 12, -13, 5, -1, -6, 15, -11, 10, -5, 6, -2];
    const spansZero = [...half, ...half.map((v) => -v)];
    const check = promotionVerdict(input({ roundTripReturnsBps: spansZero })).checks.find((c) => c.id === 'round-trips')!;
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/\[/);              // the interval IS reported
    expect(check.detail).not.toMatch(/between seeds/); // and it was stable
  });

  it('refuses an interval that moves between seeds, as an artefact rather than a result', () => {
    // A periodic series interacts with the block resampler's n^(1/3) blocks and produces bounds that
    // shift between seeds. STABILITY_TOLERANCE exists for exactly that, and the refusal must name it
    // rather than reporting a bound the next seed would move.
    const periodic = Array.from({ length: 30 }, (_, i) => ((i % 7) - 3) * 120 + 5);
    const check = promotionVerdict(input({ roundTripReturnsBps: periodic })).checks.find((c) => c.id === 'round-trips')!;
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/between seeds/);
  });

  it('one huge winner among losses does not promote, however positive the mean', () => {
    const v = promotionVerdict(input({ roundTripReturnsBps: ONE_WINNER }));
    expect(v.checks.find((c) => c.id === 'round-trips')!.passed).toBe(false);
  });

  it('states the coverage it actually achieves instead of implying a nominal 95%', () => {
    // bootstrap.ts measured 83-93% at n = 30 on heavy tails, and 79.4% at phi = 0.6. Under-coverage
    // means the interval is too NARROW, so it promotes too easily. A gate that quietly claims more
    // precision than it has is the constitution's opening failure.
    const detail = promotionVerdict(input()).checks.find((c) => c.id === 'round-trips')!.detail;
    expect(detail).toMatch(/coverage/i);
  });

  it('uses PAIRED round trips, not the count of filled sells', () => {
    // One sell can close several FIFO lots and a sell with no open lot closes none, so the two
    // numbers differ in both directions. The old check read `filledSells` and called it round trips.
    const v = promotionVerdict(input({ filledSells: 99, roundTripReturnsBps: STRONG_EDGE.slice(0, 4) }));
    expect(v.blockers[0]).toMatch(/^4 of 12 round trips/);
  });

  it('is deterministic: the same input twice gives the identical detail', () => {
    const a = promotionVerdict(input()).checks.find((c) => c.id === 'round-trips')!.detail;
    const b = promotionVerdict(input()).checks.find((c) => c.id === 'round-trips')!.detail;
    expect(a).toBe(b);
  });
});

/**
 * FR-012: specs/004 is additive. The exposure measurement changes what the report SAYS and nothing
 * about what the gate DECIDES, and that has to be enforced by test rather than by intent.
 */
describe('promotion outcomes are provably unchanged by the exposure feature (specs/004 US3)', () => {
  /**
   * T043. Every verdict pinned as a literal, captured from the gate's own output on 2026-09-18 with
   * specs/004 fully merged. Nine inputs, covering all five checks in both states and every blocker
   * string the gate can emit.
   *
   * **A golden table rather than a diff against `main`.** CI checks out at depth 1, so a test built
   * on `git diff origin/main` would either fail there or — far worse — resolve nothing and pass
   * vacuously, which is a suppression pretending to be a control. This compares against committed
   * values, so it works in any checkout and survives rebases. The one-time diff assertion T045 asks
   * for was still run, and its output is recorded in the PR.
   *
   * If this table ever needs updating, that is not a formatting chore: it means the gate's decisions
   * moved, which is a founder stop-and-ask under the constitution.
   */
  const GOLDEN: ReadonlyArray<{
    name: string; status: string; checks: ReadonlyArray<readonly [string, boolean]>; blockers: readonly string[];
    build: () => PromotionInput;
  }> = [
    { name: 'clears everything', build: () => input(), status: 'candidate',
      checks: [['round-trips', true], ['coverage', true], ['comparable', true], ['measurable', true], ['beats-baselines', true]],
      blockers: [] },
    { name: 'one trip short', build: () => input({ roundTripReturnsBps: STRONG_EDGE.slice(0, 11) }), status: 'experimental',
      checks: [['round-trips', false], ['coverage', true], ['comparable', true], ['measurable', true], ['beats-baselines', true]],
      blockers: ['11 of 12 round trips: too few to interval'] },
    { name: 'thirty mediocre trips', build: () => input({ roundTripReturnsBps: MEDIOCRE_30 }), status: 'experimental',
      checks: [['round-trips', false], ['coverage', true], ['comparable', true], ['measurable', true], ['beats-baselines', true]],
      blockers: ['30 round trips, but the interval moves 6.2% of its width between seeds (max 5%): a resampling artefact, not a result'] },
    { name: 'one winner carries the mean', build: () => input({ roundTripReturnsBps: ONE_WINNER }), status: 'experimental',
      checks: [['round-trips', false], ['coverage', true], ['comparable', true], ['measurable', true], ['beats-baselines', true]],
      blockers: ['12 round trips, mean 29.2 bps, conservative interval [-50.0, 187.5] bps vs zero (nominal 95%; measured coverage at this sample size is 79-93%, not 95%)'] },
    { name: 'loses to a baseline', build: () => input({ returnBasePct: 0.5 }), status: 'experimental',
      checks: [['round-trips', true], ['coverage', true], ['comparable', true], ['measurable', true], ['beats-baselines', false]],
      blockers: ['does not beat scheduled-accumulation (1.00%) or buy-and-hold (2.00%) in tokens (0.50%)'] },
    { name: 'return unmeasurable', build: () => input({ returnBasePct: null }), status: 'experimental',
      checks: [['round-trips', true], ['coverage', true], ['comparable', true], ['measurable', false], ['beats-baselines', false]],
      blockers: ["not measurable: ma-crossover's own token return", 'not compared: a baseline is missing, unmeasurable, or not comparable'] },
    { name: 'no coverage recorded', build: () => input({ coverage: undefined }), status: 'experimental',
      checks: [['round-trips', true], ['coverage', false], ['comparable', true], ['measurable', true], ['beats-baselines', true]],
      blockers: ['coverage was not recorded for this run'] },
    { name: 'no context', build: () => input({ context: undefined }), status: 'experimental',
      checks: [['round-trips', true], ['coverage', true], ['comparable', false], ['measurable', true], ['beats-baselines', false]],
      blockers: ["not comparable: ma-crossover's own run conditions were not recorded", 'not compared: a baseline is missing, unmeasurable, or not comparable'] },
    { name: 'is itself a baseline', build: () => input({ strategyId: 'buy-and-hold' }), status: 'experimental',
      checks: [['round-trips', false], ['coverage', true], ['comparable', true], ['measurable', true], ['beats-baselines', true]],
      blockers: ['buy-and-hold is a baseline, not a promotion candidate'] },
  ];

  it.each(GOLDEN)('$name: status, checks and blockers are IDENTICAL to the pinned verdict', (g) => {
    const v = promotionVerdict(g.build());
    expect(v.status).toBe(g.status);
    expect(v.checks.map((c) => [c.id, c.passed])).toEqual(g.checks.map((c) => [...c]));
    expect(v.blockers).toEqual([...g.blockers]);
  });

  it('covers every check in BOTH states, so the table cannot pass by only exercising the happy path', () => {
    for (const id of ['round-trips', 'coverage', 'comparable', 'measurable', 'beats-baselines']) {
      const states = new Set(GOLDEN.flatMap((g) => g.checks.filter((c) => c[0] === id).map((c) => c[1])));
      expect(states, `${id} is never seen failing or never seen passing`).toEqual(new Set([true, false]));
    }
  });

  it('T044: a STRONGLY POSITIVE alpha promotes nothing on its own', () => {
    // The run below beats holding the token by a wide margin in ADA -- alpha is positive and its
    // interval excludes zero -- and it is still barred, because its own token return loses to both
    // baselines. Exposure-adjusted skill is not a promotion criterion and this feature did not make
    // it one. Wiring alpha into the gate is a separate founder stop-and-ask.
    const prices = [0.0020, 0.00198, 0.00201, 0.00197, 0.00202, 0.00199, 0.00203, 0.00198,
      0.00204, 0.00200, 0.00205, 0.00201, 0.00206, 0.00202];
    let t = Date.UTC(2026, 8, 17);
    const equity: EquityPoint[] = prices.map((p, i) => {
      if (i > 0) t += 15 * 60_000;
      return {
        tickTs: new Date(t), cashLovelace: 0n, positionBase: 1_000_000n,
        // Tracks the token AND compounds 40 bps a tick on top: unambiguous positive alpha.
        equityLovelace: BigInt(Math.round(1_000_000_000 * (p / prices[0]!) * 1.004 ** i)),
        equityExecutableLovelace: null, price: p.toFixed(18),
      };
    });
    const e = exposureAdjusted(equity);
    expect(e.kind).toBe('measured');
    if (e.kind !== 'measured') return;
    expect(e.alphaBps).toBeGreaterThan(0);
    expect(e.alphaLowerBps).toBeGreaterThan(0); // the interval EXCLUDES zero on the upside

    const v = promotionVerdict(input({ returnBasePct: 0.5 }));
    expect(v.status).toBe('experimental');
    expect(v.blockers).toContain('does not beat scheduled-accumulation (1.00%) or buy-and-hold (2.00%) in tokens (0.50%)');
  });

  it('T045: the gate cannot SEE the measurement — no import either way, and no input field', () => {
    // The structural half of the invariance. The golden table above catches a behaviour change;
    // this catches the wiring that would make one possible, which is the change someone would
    // actually make first.
    const promotionSrc = readFileSync(resolve(import.meta.dirname, '../src/promotion.ts'), 'utf8');
    const exposureSrc = readFileSync(resolve(import.meta.dirname, '../src/exposure.ts'), 'utf8');
    expect(promotionSrc).not.toMatch(/from ['"]\.\/exposure\.js['"]/);
    expect(exposureSrc).not.toMatch(/from ['"]\.\/promotion\.js['"]/);
    // And nothing exposure-shaped reached PromotionInput. `equity` is named too because that is the
    // raw material: hand the gate the observations and alpha is one function call away.
    const inputBlock = promotionSrc.slice(promotionSrc.indexOf('export interface PromotionInput'));
    const body = inputBlock.slice(0, inputBlock.indexOf('\n}'));
    for (const forbidden of ['alpha', 'beta', 'exposure', 'equity']) {
      expect(body.toLowerCase(), `PromotionInput mentions ${forbidden}`).not.toMatch(new RegExp(forbidden));
    }
  });
});
