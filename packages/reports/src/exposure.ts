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
import { bcaInterval, conservativeBounds, type Statistic } from './bootstrap.js';
import { priceScaled, ratioOf } from './decimal.js';
import { ASSUMED_STAKING_APR_PCT } from './staking.js';

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
const BPS = 10_000;

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

export function exposureAdjusted(observations: readonly EquityPoint[]): ExposureResult | ExposureRefusal {
  if (observations.length === 0) {
    return { kind: 'refused', reason: 'not-applicable', detail: 'this run records no equity observations, so exposure cannot be measured' };
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
  if (f === null) {
    return { kind: 'refused', reason: 'benchmark-did-not-move', detail: 'the benchmark price did not move across the window: beta is undefined, and any alpha would be the whole return mislabelled' };
  }

  // Resample PAIRS, not residuals: residual resampling assumes the residual variance does not
  // depend on the regressor, and crypto returns violate that in the direction that NARROWS the
  // interval. Indices carry whole tuples through the existing block resampler, so each
  // observation's own noise stays attached to it.
  const indices = pairs.map((_, i) => i);
  const alphaOf: Statistic = (idxs) => {
    const picked = idxs.map((i) => pairs[i]!).filter((p) => p !== undefined);
    return fit(picked)?.alpha ?? f.alpha;
  };
  const interval = bcaInterval(indices, alphaOf, { seed: 1 });
  const bounds = interval === null ? { lower: f.alpha, upper: f.alpha } : conservativeBounds(interval);

  const exposed = observations.filter((o) => o.positionBase > 0n).length;
  return {
    kind: 'measured',
    alphaBps: f.alpha,
    alphaLowerBps: Number.isFinite(bounds.lower) ? bounds.lower : f.alpha,
    alphaUpperBps: Number.isFinite(bounds.upper) ? bounds.upper : f.alpha,
    alphaDenomination: 'ADA',
    beta: f.beta,
    observations: pairs.length,
    zeroBenchmarkPairs: pairs.filter((p) => Math.abs(p.benchmarkExcessBps + cashChargeBps(p.toTs.getTime() - p.fromTs.getTime())) < 1e-9).length,
    assumedStakingAprPct: ASSUMED_STAKING_APR_PCT,
    exposedFraction: exposed / observations.length,
  };
}
