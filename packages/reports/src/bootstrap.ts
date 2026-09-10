/**
 * Bias-corrected and accelerated (BCa) bootstrap confidence intervals.
 *
 * Built for the promotion gate. Its n = 30 threshold came from a normal-theory conversion which
 * `roundTrips.ts` then measured as unsound — excess kurtosis of 8.38, 13.06 and 2.54 across three
 * corpora, with a measured-to-implied sigma ratio running 0.63 to 1.29 in BOTH directions. There is
 * no multiplier that repairs that; a distribution-free interval replaces the arithmetic entirely.
 *
 * **BCa was recommended on the grounds that plain percentile intervals under-cover in small,
 * fat-tailed samples. A coverage simulation says that is not true in OUR regime**, so both intervals
 * are returned and neither is the default. 600 trials per row, 600 resamples, nominal 95%:
 *
 *     distribution (n=30)      BCa     percentile
 *     normal                  93.7%        93.5%
 *     exponential             90.8%        91.3%
 *     lognormal (skewed)      89.2%        88.2%   <- BCa wins, as the textbook says
 *     fat-tailed (symmetric)  83.0%        90.2%   <- BCa LOSES, badly
 *     fat-tailed, n=90        88.0%        91.5%
 *
 * The mechanism: the jackknife acceleration is a third-moment estimate. On a symmetric heavy-tailed
 * sample the TRUE correction is about zero, but any particular sample's realised skew is large and
 * driven by whichever outliers were drawn — so BCa applies a noisy correction where none is wanted
 * and shifts the interval in a random direction each time. That it is a near no-op on normal data
 * and a genuine improvement on lognormal is what says the implementation is right rather than broken.
 *
 * **Read the last column of that table before trusting any of this**: at n = 30 on heavy tails NO
 * bootstrap flavour reaches 95% — they deliver 83-93%. That is a stronger argument about the
 * promotion gate's sample size than the sigma-multiplier debate ever was.
 *
 * Hence `conservativeBounds`, which the gate should use: the WIDEST of the two intervals, fail-closed,
 * so nothing rests on picking a winner the evidence does not support.
 *
 * No dependency: `@ctb/reports` imports nothing at runtime (`purity.guard.test.ts`), so the normal
 * CDF, its inverse and the RNG are all local and all deterministic.
 */

/** At least the 1000 the reviewed practice asks for; 2000 because a BCa tail is estimated from the
 * extreme percentiles, which are the least stable part of the resample distribution. */
export const BOOTSTRAP_RESAMPLES = 2_000;

/** Bound movement between seeds, as a fraction of interval width, above which an interval is not
 * to be trusted near a decision boundary. */
export const STABILITY_TOLERANCE = 0.05;

export const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Numerical Recipes `erfcc` — fractional error below 1.2e-7, far finer than any interval needs. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const ans = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? ans : 2 - ans;
}

/** Standard normal CDF. */
const normalCdf = (x: number): number => 0.5 * erfc(-x / Math.SQRT2);

/** Acklam's inverse normal CDF; relative error under 1.2e-9 across the open unit interval. */
function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** mulberry32: small, fast, and fully determined by its seed, which is what the stability check needs. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const percentile = (sorted: readonly number[], p: number): number => {
  const i = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};

export interface BcaInterval {
  estimate: number;
  lower: number;
  upper: number;
  /** The plain percentile interval, carried so the correction can be SEEN rather than trusted. */
  percentileLower: number;
  percentileUpper: number;
  level: number;
  resamples: number;
  /** Bias correction. 0 when exactly half the resamples fall below the estimate. */
  z0: number;
  /** Jackknife acceleration. 0 for a symmetric statistic; away from 0 is skew being corrected. */
  acceleration: number;
  /** The corrections could not be computed — every resample identical, or a non-finite fit — and
   * the plain percentile interval was used instead. Never silently: a degenerate interval that
   * reads as a real one is the failure this flag exists to prevent. */
  degenerate: boolean;
}

export type Statistic = (xs: readonly number[]) => number;

export interface BcaOptions { resamples?: number; level?: number; seed?: number }

/** Null below two observations: a jackknife needs at least two leave-one-out samples, and a "point
 * interval" from one observation would read as a measurement. */
export function bcaInterval(sample: readonly number[], stat: Statistic, opts: BcaOptions = {}): BcaInterval | null {
  const n = sample.length;
  if (n < 2) return null;
  const B = opts.resamples ?? BOOTSTRAP_RESAMPLES;
  const level = opts.level ?? 0.95;
  const next = rng(opts.seed ?? 1);

  const estimate = stat(sample);
  const boots: number[] = [];
  const draw = new Array<number>(n);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < n; i++) draw[i] = sample[Math.floor(next() * n)]!;
    boots.push(stat(draw));
  }
  boots.sort((x, y) => x - y);

  const alpha = (1 - level) / 2;
  const percentileLower = percentile(boots, alpha);
  const percentileUpper = percentile(boots, 1 - alpha);

  const below = boots.filter((v) => v < estimate).length;
  const proportion = below / B;
  // z0 is infinite when every resample sits on one side of the estimate, which is a degenerate fit
  // rather than an extreme correction.
  const z0 = proportion <= 0 || proportion >= 1 ? NaN : normalQuantile(proportion);

  // Jackknife acceleration from leave-one-out estimates.
  const jack: number[] = [];
  for (let i = 0; i < n; i++) jack.push(stat(sample.filter((_, j) => j !== i)));
  const jackMean = mean(jack);
  let s2 = 0;
  let s3 = 0;
  for (const j of jack) {
    const d = jackMean - j;
    s2 += d * d;
    s3 += d * d * d;
  }
  const acceleration = s2 === 0 ? NaN : s3 / (6 * Math.pow(s2, 1.5));

  const degenerate = !Number.isFinite(z0) || !Number.isFinite(acceleration);
  if (degenerate) {
    return {
      estimate, lower: percentileLower, upper: percentileUpper, percentileLower, percentileUpper,
      level, resamples: B, z0: Number.isFinite(z0) ? z0 : 0, acceleration: Number.isFinite(acceleration) ? acceleration : 0,
      degenerate: true,
    };
  }

  const adjust = (a: number): number => {
    const z = normalQuantile(a);
    return normalCdf(z0 + (z0 + z) / (1 - acceleration * (z0 + z)));
  };
  return {
    estimate,
    lower: percentile(boots, adjust(alpha)),
    upper: percentile(boots, adjust(1 - alpha)),
    percentileLower, percentileUpper, level, resamples: B, z0, acceleration, degenerate: false,
  };
}

export interface BcaStability {
  /** The largest movement of either bound across the seeds, as a fraction of the median interval
   * width — unitless, so it means the same thing whatever the statistic measures. */
  maxBoundShiftFraction: number;
  stable: boolean;
  intervals: BcaInterval[];
}

/**
 * The convergence check: rerun with different seeds and confirm the bounds do not move. An interval
 * that shifts between seeds is a resampling artefact, and near a promotion boundary that artefact
 * IS the decision.
 */
export function bcaStability(
  sample: readonly number[], stat: Statistic, opts: BcaOptions & { seeds?: number[] } = {},
): BcaStability | null {
  const seeds = opts.seeds ?? [1, 2, 3];
  const intervals: BcaInterval[] = [];
  for (const seed of seeds) {
    const r = bcaInterval(sample, stat, { ...opts, seed });
    if (r === null) return null;
    intervals.push(r);
  }
  const widths = intervals.map((i) => i.upper - i.lower).sort((a, b) => a - b);
  const width = percentile(widths, 0.5);
  const spread = (pick: (i: BcaInterval) => number): number =>
    Math.max(...intervals.map(pick)) - Math.min(...intervals.map(pick));
  const shift = Math.max(spread((i) => i.lower), spread((i) => i.upper));
  // A zero-width interval cannot move as a fraction of itself; treat any movement there as unstable
  // and no movement as stable, rather than dividing by zero.
  const fraction = width > 0 ? shift / width : shift > 0 ? Infinity : 0;
  return { maxBoundShiftFraction: fraction, stable: fraction < STABILITY_TOLERANCE, intervals };
}

/**
 * The union of the BCa and percentile intervals — the widest available bound.
 *
 * The promotion gate's job is to refuse, so where two defensible intervals disagree it takes the one
 * that makes promotion harder. This is not indecision: the coverage simulation in this file's header
 * shows neither method dominates across the distribution shapes we might be in, and both under-cover
 * at n = 30 regardless. Choosing the wider one is the only reading that fails closed.
 *
 * A wide gap between the two is itself information — it means the sample's estimated skew is doing
 * real work, so the shape matters and the sample is probably too small to settle it.
 */
export function conservativeBounds(r: BcaInterval): { lower: number; upper: number; methodsDisagreeBy: number } {
  const lower = Math.min(r.lower, r.percentileLower);
  const upper = Math.max(r.upper, r.percentileUpper);
  const width = upper - lower;
  const disagreement = Math.abs(r.lower - r.percentileLower) + Math.abs(r.upper - r.percentileUpper);
  return { lower, upper, methodsDisagreeBy: width > 0 ? disagreement / width : 0 };
}
