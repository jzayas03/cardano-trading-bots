/**
 * Exposure-adjusted comparison: alpha and beta against holding the token.
 *
 * The gate's baseline check compares one token-denominated return strictly against both baselines
 * with NO adjustment for exposure. `scheduled-accumulation` is essentially always long while
 * `ma-crossover` sits in cash much of the time, so that check treats a half-exposed strategy and a
 * fully exposed one as equivalent and cannot tell skill from bought exposure. This measures the
 * difference. **It decides nothing** — wiring it into the gate is a separate founder decision.
 *
 * **The zeros are real, and that is the whole design.** 67.6% of consecutive benchmark returns on
 * the live runs are exactly zero. An earlier design called that a stale price carried forward,
 * argued errors-in-variables attenuation, and collapsed the series to price-change intervals to fix
 * it. Measured 2026-09-17: in all 55 same-reserve snapshot pairs the BLOCK HEIGHT ADVANCED, and the
 * pool is sampled about every 5 minutes against a 900 s tick. The chain moved, the collector looked,
 * and the pool was not traded. These are accurate observations of a market that stood still, so
 * there is no measurement error to correct — and collapsing would have given the intercept varying
 * durations, which stops alpha being a rate at all. Regress at the tick interval; a flat market is
 * data. See specs/004-alpha-beta-reporting/research.md R1.
 *
 * Units are load-bearing (Constitution II). The regression is in **ADA**, on the run's own recorded
 * price. The mandate's return is TOKEN-denominated and holding the token returns about zero in token
 * terms by construction, so a beta against it only means anything in ADA. The two denominations are
 * never mixed and never summed.
 */
import type { EquityPoint } from '@ctb/engine';
import { bcaInterval, bcaStability, conservativeBounds, type Statistic } from './bootstrap.js';
import { priceScaled, ratioOf } from './decimal.js';
import { ASSUMED_STAKING_APR_PCT } from './staking.js';

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
const BPS = 10_000;

/**
 * Below this relative width a half-window interval carries no information: resampling moved the
 * bound by less than lovelace rounding did.
 *
 * **Measured, not chosen.** On runs 150-153 (2026-09-18) the eight half intervals split into two
 * groups four orders of magnitude apart: the six real ones had relative widths from 0.9 to 43, and
 * the two collapsed ones — the second halves of `scheduled-accumulation` and `buy-and-hold`, both
 * fully invested and merely holding — came out at 9.4e-5 and 2.6e-4. Anything in that gap separates
 * them; this sits in the middle of it rather than against either edge.
 */
const DEGENERATE_RELATIVE_WIDTH = 1e-3;

/** One consecutive pair of tick observations. Both series span the SAME interval, by construction. */
export interface ReturnPair {
  fromTs: Date;
  toTs: Date;
  /** The token's ADA return over the interval, less the cash charge. Zero is valid data. */
  benchmarkExcessBps: number;
  /** The run's ADA equity return over the SAME interval, less the cash charge. */
  strategyExcessBps: number;
}

export type ExposureRefusalReason =
  | 'not-applicable' | 'too-few-observations' | 'benchmark-did-not-move'
  | 'no-position-taken' | 'window-open';

export interface ExposureRefusal {
  kind: 'refused';
  reason: ExposureRefusalReason;
  detail: string;
}

/** A beta fitted on one half of the window, with its own interval. Null when that half has no slope. */
export interface HalfBeta {
  beta: number;
  lower: number;
  upper: number;
  pairs: number;
  /**
   * The interval collapsed to a point: every residual in this half was zero, so every resample
   * returned the same slope. **Measured on run 150 (2026-09-18): a strategy that finishes
   * accumulating and then simply holds has equity that tracks the price exactly, and its second
   * half's interval came out `[0.997, 0.997]`.** An overlap test against a point is not a test, so a
   * degenerate half disables the comparison rather than winning it.
   */
  degenerate: boolean;
}

export interface ExposureOptions {
  /**
   * Whether the run's window is CLOSED. The module cannot derive this: equity observations do not
   * say whether more are coming, and reading a clock would break the purity guard. The caller holds
   * the fact (`runs.finished_at`) and passes it. Omitting it asserts the window is closed.
   */
  runFinished?: boolean;
  /** Resample count, for tests. The report never passes it. */
  resamples?: number;
}

export interface ExposureResult {
  kind: 'measured';
  /** Fitted intercept. ADA-denominated, per tick interval. */
  alphaBps: number;
  alphaLowerBps: number;
  alphaUpperBps: number;
  /** Stated rather than assumed: the gate's own return is in TOKENS and is never summed with this. */
  alphaDenomination: 'ADA';
  /** Fitted slope. Unitless. */
  beta: number;
  observations: number;
  /** How many pairs had a zero benchmark return — the visible measure of how little the pool traded. */
  zeroBenchmarkPairs: number;
  /** Shown, never folded into the headline: an assumption inside a number stops being questioned. */
  assumedStakingAprPct: number;
  /** Fraction of observations holding a position. Context for beta. */
  exposedFraction: number;
  /**
   * `n (1 - rho) / (1 + rho)`, floored at 1 and capped at `n`. The standard AR(1) variance-inflation
   * adjustment, whose assumption is nameable: that the dependence is approximately first-order.
   *
   * **This is the only thing between a raw count of ~700 ticks a week and a reader's impression of
   * how much independent evidence exists**, so it is reported beside the raw count, never instead
   * of it. It discounts DEPENDENCE and nothing else -- see `informativePairs`.
   */
  effectiveObservations: number;
  /**
   * `rho`: the lag-1 autocorrelation of the REGRESSION RESIDUALS, reported so the input to `n_eff`
   * is visible rather than assumed.
   *
   * Residuals rather than raw returns, because it is the residual series whose dependence inflates
   * the variance of alpha. The raw benchmark series would measure how much the MARKET repeats
   * itself, which is a fact about Cardano and not about how much this run's evidence is worth.
   */
  lag1Autocorrelation: number;
  /**
   * Pairs in which the benchmark actually moved. **A separate defect from dependence, and one
   * `n_eff` does not catch**: a series of exact zeros is uninformative but not autocorrelated, so
   * zero-inflation passes the AR(1) adjustment untouched. Two thirds of live pairs are zero because
   * the pool went untraded, so this number is the one that says how weakly beta is identified.
   */
  informativePairs: number;
  /** Beta on the first half of the window. Null when that half's benchmark did not move. */
  betaFirstHalf: HalfBeta | null;
  /** Beta on the second half. Together with the first, this answers DID THE EXPOSURE DRIFT. */
  betaSecondHalf: HalfBeta | null;
  /**
   * Whether the two half-window beta intervals overlap. Null when either half has no slope.
   *
   * **Not the same question as `alphaSeedStable`, and the two must stay labelled apart.** This asks
   * whether the parameter itself moved; that one asks whether the interval is a numerical artefact.
   * Conflating them would let a stable-seed reading be quoted as a stable-exposure claim, which is a
   * claim about the strategy that nobody measured.
   */
  betaHalvesOverlap: boolean | null;
  /**
   * Whether alpha's interval holds still across resampling seeds (`bcaStability`). A SEED property,
   * not a strategy property. See `betaHalvesOverlap`.
   */
  alphaSeedStable: boolean;
}

/** The cash charge for an interval, in bps — what idle ADA forgoes over its REAL duration. */
const cashChargeBps = (ms: number): number => (ASSUMED_STAKING_APR_PCT / 100) * (ms / MS_PER_YEAR) * BPS;

/**
 * Consecutive observations to excess returns. Nothing is collapsed and nothing is dropped for being
 * flat — a zero benchmark return means the pool was not traded, which is an observation.
 */
export function returnPairs(observations: readonly EquityPoint[]): ReturnPair[] {
  const out: ReturnPair[] = [];
  for (let i = 1; i < observations.length; i++) {
    const a = observations[i - 1]!;
    const b = observations[i]!;
    const pa = priceScaled(a.price);
    const pb = priceScaled(b.price);
    // A price nobody can read makes its pair unmeasurable rather than zero.
    if (pa === null || pb === null || a.equityLovelace <= 0n) continue;
    const ms = b.tickTs.getTime() - a.tickTs.getTime();
    if (ms <= 0) continue;
    const rf = cashChargeBps(ms);
    out.push({
      fromTs: a.tickTs,
      toTs: b.tickTs,
      benchmarkExcessBps: (ratioOf(pa, pb) - 1) * BPS - rf,
      strategyExcessBps: (ratioOf(a.equityLovelace, b.equityLovelace) - 1) * BPS - rf,
    });
  }
  return out;
}

interface Fit { alpha: number; beta: number }

/**
 * Ordinary least squares, alpha as the FITTED INTERCEPT rather than a residual mean. The two
 * coincide only when beta is already correct, which is the thing being estimated.
 */
function fit(pairs: readonly ReturnPair[]): Fit | null {
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (const p of pairs) { sx += p.benchmarkExcessBps; sy += p.strategyExcessBps; }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0, sxx = 0;
  for (const p of pairs) {
    const dx = p.benchmarkExcessBps - mx;
    sxy += dx * (p.strategyExcessBps - my);
    sxx += dx * dx;
  }
  // No spread in the regressor means no slope is defined. Returning 0 would report a confident
  // beta of zero for a benchmark that simply never moved.
  if (sxx === 0) return null;
  const beta = sxy / sxx;
  return { beta, alpha: my - beta * mx };
}

/**
 * Lag-1 autocorrelation. Zero when the series does not vary: a constant series has no dependence to
 * measure, and `0/0` would propagate a NaN into `n_eff` and from there into the reported evidence.
 */
function lag1(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i]! - m;
    den += d * d;
    if (i > 0) num += d * (xs[i - 1]! - m);
  }
  if (den === 0) return 0;
  const r = num / den;
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : 0;
}

/** `n (1 - rho) / (1 + rho)`, floored at 1 and capped at n. `rho = -1` would divide by zero. */
function effectiveN(n: number, rho: number): number {
  if (rho <= -1) return n;
  const adjusted = (n * (1 - rho)) / (1 + rho);
  if (!Number.isFinite(adjusted)) return n;
  return Math.min(n, Math.max(1, adjusted));
}

/** Beta over one half of the window, with its own interval. Null when that half has no slope. */
function halfBeta(pairs: readonly ReturnPair[], resamples: number | undefined): HalfBeta | null {
  const f = fit(pairs);
  if (f === null || !Number.isFinite(f.beta)) return null;
  const indices = pairs.map((_, i) => i);
  const betaOf: Statistic = (idxs) => {
    const picked = idxs.map((i) => pairs[i]!).filter((x) => x !== undefined);
    const g = fit(picked);
    return g === null || !Number.isFinite(g.beta) ? f.beta : g.beta;
  };
  const interval = bcaInterval(indices, betaOf, { seed: 1, ...(resamples === undefined ? {} : { resamples }) });
  const b = interval === null ? { lower: f.beta, upper: f.beta } : conservativeBounds(interval);
  const lower = Number.isFinite(b.lower) ? b.lower : f.beta;
  const upper = Number.isFinite(b.upper) ? b.upper : f.beta;
  const width = upper - lower;
  // Relative to the estimate, because beta is unitless and a strategy's may be 0.004 or 1.0. A beta
  // indistinguishable from zero has no scale to divide by, so it falls back to the absolute width.
  const scale = Math.abs(f.beta);
  const degenerate = scale > DEGENERATE_RELATIVE_WIDTH
    ? width / scale < DEGENERATE_RELATIVE_WIDTH
    : width < DEGENERATE_RELATIVE_WIDTH;
  return { beta: f.beta, lower, upper, pairs: pairs.length, degenerate };
}

/**
 * Exactly one outcome per input, in this order, with no default-bearing fallthrough. The order
 * matters and is not the one the data model first drafted: a single observation has no price change
 * either, so testing "the benchmark did not move" before "too few to fit" would report an undefined
 * slope where the honest answer is that there is nothing to fit yet.
 */
export function exposureAdjusted(
  observations: readonly EquityPoint[], options: ExposureOptions = {},
): ExposureResult | ExposureRefusal {
  if (observations.length === 0) {
    return { kind: 'refused', reason: 'not-applicable', detail: 'this run records no equity observations, so exposure cannot be measured' };
  }
  // A window still being written is not a result. Reported today it is a finding that changes
  // tomorrow, and the first reader to quote it will not re-check it.
  if (options.runFinished === false) {
    return { kind: 'refused', reason: 'window-open', detail: 'the run is still in progress: a partial window is not a result' };
  }
  // A strategy that never held a position has a beta of zero BY CONSTRUCTION. Reporting that as a
  // measurement would dress a definition up as a finding.
  if (observations.every((o) => o.positionBase === 0n)) {
    return { kind: 'refused', reason: 'no-position-taken', detail: 'the run never held a position: beta is 0 by construction, which is a definition rather than a measurement of skill' };
  }
  const pairs = returnPairs(observations);
  if (pairs.length < 2) {
    return { kind: 'refused', reason: 'too-few-observations', detail: `${pairs.length} return pairs: too few to fit` };
  }
  const f = fit(pairs);
  if (f === null || !Number.isFinite(f.alpha) || !Number.isFinite(f.beta)) {
    return { kind: 'refused', reason: 'benchmark-did-not-move', detail: 'the benchmark price did not move across the window: beta is undefined, and any alpha would be the whole return mislabelled' };
  }

  // Resample PAIRS, not residuals: residual resampling assumes the residual variance does not
  // depend on the regressor, and crypto returns violate that in the direction that NARROWS the
  // interval. Indices carry whole tuples through the existing block resampler, so each
  // observation's own noise stays attached to it.
  const indices = pairs.map((_, i) => i);
  const alphaOf: Statistic = (idxs) => {
    const picked = idxs.map((i) => pairs[i]!).filter((p) => p !== undefined);
    const g = fit(picked);
    return g === null || !Number.isFinite(g.alpha) ? f.alpha : g.alpha;
  };
  const resampleOpt = options.resamples === undefined ? {} : { resamples: options.resamples };
  const interval = bcaInterval(indices, alphaOf, { seed: 1, ...resampleOpt });
  const bounds = interval === null ? { lower: f.alpha, upper: f.alpha } : conservativeBounds(interval);
  // Seed sensitivity: is the interval a numerical artefact? NOT whether the exposure drifted.
  const stability = bcaStability(indices, alphaOf, resampleOpt);

  const residuals = pairs.map((p) => p.strategyExcessBps - (f.alpha + f.beta * p.benchmarkExcessBps));
  const rho = lag1(residuals);

  const mid = Math.floor(pairs.length / 2);
  const first = halfBeta(pairs.slice(0, mid), options.resamples);
  const second = halfBeta(pairs.slice(mid), options.resamples);
  // A degenerate half disables the comparison. Run 150's second-half interval was a single point, and
  // "DISJOINT, the exposure drifted" resting on a point is a claim about the strategy carried by an
  // artefact. The point estimates are still both reported, so a reader can see the move themselves.
  const overlap = first === null || second === null || first.degenerate || second.degenerate
    ? null
    : first.lower <= second.upper && second.lower <= first.upper;

  const exposed = observations.filter((o) => o.positionBase > 0n).length;
  const zeroBenchmarkPairs = pairs.filter((p) => Math.abs(p.benchmarkExcessBps + cashChargeBps(p.toTs.getTime() - p.fromTs.getTime())) < 1e-9).length;
  return {
    kind: 'measured',
    alphaBps: f.alpha,
    alphaLowerBps: Number.isFinite(bounds.lower) ? bounds.lower : f.alpha,
    alphaUpperBps: Number.isFinite(bounds.upper) ? bounds.upper : f.alpha,
    alphaDenomination: 'ADA',
    beta: f.beta,
    observations: pairs.length,
    zeroBenchmarkPairs,
    assumedStakingAprPct: ASSUMED_STAKING_APR_PCT,
    exposedFraction: exposed / observations.length,
    effectiveObservations: effectiveN(pairs.length, rho),
    lag1Autocorrelation: rho,
    informativePairs: pairs.length - zeroBenchmarkPairs,
    betaFirstHalf: first,
    betaSecondHalf: second,
    betaHalvesOverlap: overlap,
    alphaSeedStable: stability?.stable ?? false,
  };
}
