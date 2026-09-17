import type { RunCoverage } from '@ctb/engine';

/**
 * When a strategy may stop being called experimental — founder sign-off 2026-09-09, thresholds
 * agreed BEFORE the seven-day run's results existed. That order matters more than the numbers: a
 * gate chosen after seeing which side of it the results fall on is fitted to the answer, and this
 * project has already published one rate (7.1% of fourteen windows) as if it were a finding.
 *
 * The gate BARS; it does not warn. A status a strategy cannot earn is worth more than a caution a
 * reader can skip past.
 *
 * `candidate` is the highest rung anything here can reach. Live trading is armed by hand, by the
 * founder, and nothing in this file has an opinion about it.
 */
export type PromotionStatus = 'experimental' | 'candidate';

/**
 * Thirty completed round trips.
 *
 * Not a round number: NIGHT's median absolute two-hour move is 82 bps, and for a roughly normal
 * distribution `median|X| ~= 0.674σ`, so per-trade dispersion is about 122 bps. Detecting an edge
 * `e` at 95% needs `n >= (1.96σ/e)²` — 6 trades for a 100 bps edge, 23 for 50 bps, 92 for 25 bps.
 * Thirty sits just above the 50 bps case, deliberately: an edge smaller than that cannot be told
 * apart from the cost floor's own error bar, whose batcher component is an assumption worth ±40 bps.
 *
 * Consequence, and it is the point: at the current fill rate a seven-day run yields roughly seven
 * round trips, so a week promotes nothing. The lever for a promotable answer is more instruments in
 * parallel, not a longer wait on one.
 *
 * **2026-09-09, measured: the conversion above is unsound, and NOT in a way a constant fixes.**
 * `roundTrips.ts` was built to check it against real fills. Across three distinct corpora (83, 162
 * and 148 completed round trips) excess kurtosis came out at 8.38, 13.06 and 2.54 — every one
 * strongly positive, so the returns are decisively not normal, and kurtosis is dimensionless so that
 * conclusion survives those corpora being priced in USD.
 *
 * But the ratio of measured σ to normal-implied σ was 1.02, 1.29 and 0.63: it runs in BOTH
 * directions and varies by more than 2x. So there is no multiplier to apply — choosing one would be
 * fitting to whichever corpus was looked at. The parametric route to a sample size is the wrong
 * tool here, not a mis-tuned one, and the fix is a bootstrap over actual round-trip returns rather
 * than a new constant.
 *
 * 30 therefore STANDS unchanged, on the same pre-registration logic that set it: it was fixed before
 * the data, and nothing measured since gives a principled reason to move it. Revisit when there are
 * ADA-denominated round trips to bootstrap against.
 */
export const MIN_ROUND_TRIPS = 30;

/**
 * The gate's own minimum before an interval is computed at all. **Twelve, and it is a
 * pre-registered judgement rather than a derivation** (specs/003 research R5) — saying otherwise
 * would manufacture rigour, which is the failure this replacement exists to correct.
 *
 * What bounds it: below roughly n = 10 a BCa acceleration is estimated from too few leave-one-out
 * replicates to describe the skew, and this project's corpora sit at the severe end of skew
 * (excess kurtosis 8.38, 13.06, 2.54). What makes it defensible despite not being derived: EVERY
 * run in the database has fewer than twelve round trips, the largest being eight, so the value
 * cannot have been fitted to let anything through.
 *
 * It is deliberately NOT coupled to `costFloor.ts`'s `MIN_OBSERVATIONS`, which keeps 30 for its own
 * reason. Coupling them would drag the cost floor's sufficiency bar down with this change, which is
 * a cost-model change and a founder decision, not a side effect.
 */
export const MIN_TRIPS_FOR_INTERVAL = 12;

/** A run that did not see its window did not measure it. Percent of expected buckets. */
export const MIN_COVERAGE_PCT = 80;

/** Consecutive candle pairs wider than the stale-fill bound, as a percent of candles. */
export const MAX_GAPS_OVER_BOUND_PCT = 5;

/**
 * Beating zero is not the bar; beating doing-nothing is. Both baselines must be present over the
 * IDENTICAL window — a missing one bars rather than being skipped, which is what puts
 * `scheduled-accumulation` on the critical path for any promotion at all.
 */
export const BASELINE_STRATEGIES = ['scheduled-accumulation', 'buy-and-hold'] as const;

/**
 * What makes two runs COMPARABLE. Without these the gate was taking "the other runs in this
 * comparison" as baselines on trust — so a strategy could clear it against a comparator that traded
 * a different token, over a different window, with different capital. A gate whose entire job is to
 * refuse must not accept a comparison it cannot justify.
 */
export interface RunContext {
  baseUnit: string;
  windowFromMs: number;
  windowToMs: number;
  startEquityLovelace: bigint;
}

/** Windows must overlap by at least this fraction of their union. Runs start minutes apart in
 * practice; they must not be measuring different weeks. */
export const MIN_WINDOW_OVERLAP = 0.95;

/** Starting capital may differ by at most this fraction. Costs are largely FIXED per order, so a
 * comparator with materially more capital faces a materially lower cost floor on the same trade. */
export const MAX_CAPITAL_DRIFT = 0.01;

export interface PromotionInput {
  strategyId: string;
  /** Undefined bars: a comparison whose conditions cannot be read is not a comparison. */
  context?: RunContext;
  /**
   * Filled SELL ORDERS. Kept because the report prints it, and deliberately NOT used to decide the
   * round-trip check: one sell can close several FIFO lots and a sell with no open lot closes none,
   * so this differs from the paired round-trip count in both directions (specs/003 research R8).
   */
  filledSells: number;
  /**
   * Paired round-trip returns in bps, ALREADY NET of pool fee, price impact, batcher fee and
   * network fee — the pairing subtracts both legs' fees and the fill is priced through the pool.
   * Zero is therefore the correct comparand and subtracting a cost floor again would charge costs
   * twice (specs/003 research R1).
   */
  roundTripReturnsBps: readonly number[];
  /** Token-denominated return — the mandate's denominator, not ADA. Null when unmeasurable. */
  returnBasePct: number | null;
  coverage: RunCoverage | undefined;
  /** The other runs over the same window, whatever they are; the required ones are selected here. */
  baselines: ReadonlyArray<{ strategyId: string; returnBasePct: number | null; context?: RunContext }>;
  /**
   * Which baselines this strategy must beat. Defaults to `BASELINE_STRATEGIES`, the taking sleeve's
   * pair, and is a PARAMETER rather than a global because sleeves do not share a reference: an LP
   * position's benchmark is holding the 50/50 basket or holding the token, not a DCA it has nothing
   * in common with. Better made a parameter before an LP run exists than after one is misjudged.
   */
  requiredBaselines?: readonly string[];
}

import { bcaStability, conservativeBounds, mean, STABILITY_TOLERANCE } from './bootstrap.js';

export interface PromotionCheck {
  id: 'round-trips' | 'coverage' | 'comparable' | 'measurable' | 'beats-baselines';
  passed: boolean;
  detail: string;
}

export interface PromotionVerdict {
  status: PromotionStatus;
  /** Every check, passing or not — a gate that only speaks when it fails cannot be audited. */
  checks: PromotionCheck[];
  /** Every reason it is not a candidate, not merely the first: fixing one must not reveal another. */
  blockers: string[];
}

const pct = (part: number, whole: number): number => (whole === 0 ? 0 : (part / whole) * 100);

/**
 * Whether a run's round trips are evidence of an edge, rather than how many there are.
 *
 * The count this replaces had no significance test behind it, and its n = 30 came from a
 * normal-theory conversion that `roundTrips.ts` then measured as unsound. A count cannot express
 * the property the gate actually needs: a large obvious edge should clear on few trips while a
 * marginal one clears on none.
 *
 * **`conservativeBounds`, not BCa alone.** `bootstrap.ts` simulated coverage in THIS repo's regime
 * and found BCa loses badly on fat-tailed symmetric data (83.0% against percentile's 90.2% at
 * n = 30), while winning on lognormal. Taking the WIDEST of the two bounds is fail-closed and does
 * not rest on picking a winner the evidence does not support.
 *
 * **Seed stability is consulted, not assumed.** An interval whose bounds move between seeds is a
 * resampling artefact, and near a promotion boundary that artefact IS the decision.
 *
 * Exactly three outcomes and no default-bearing fourth: too few trips, unstable interval, or an
 * interval compared against zero.
 */
function roundTripEvidence(returnsBps: readonly number[]): PromotionCheck {
  const n = returnsBps.length;
  // No interval below the minimum. A bound computed from too few trips reads as evidence, and the
  // absence of one is the honest signal.
  if (n < MIN_TRIPS_FOR_INTERVAL) {
    return { id: 'round-trips', passed: false, detail: `${n} of ${MIN_TRIPS_FOR_INTERVAL} round trips: too few to interval` };
  }
  const stability = bcaStability(returnsBps, mean);
  if (stability === null) {
    return { id: 'round-trips', passed: false, detail: `${n} round trips produced no interval` };
  }
  if (!stability.stable) {
    return {
      id: 'round-trips',
      passed: false,
      detail: `${n} round trips, but the interval moves ${(stability.maxBoundShiftFraction * 100).toFixed(1)}% of its width between seeds (max ${(STABILITY_TOLERANCE * 100).toFixed(0)}%): a resampling artefact, not a result`,
    };
  }
  const first = stability.intervals[0]!;
  const { lower, upper } = conservativeBounds(first);
  return {
    id: 'round-trips',
    passed: lower > 0,
    // COVERAGE IS STATED, not implied. bootstrap.ts measures 83-93% at n = 30 on heavy tails and
    // 79.4% at phi = 0.6 even blocked and conservative — so a pass here is NOT a 95% claim, and
    // under-coverage means the interval is too narrow, i.e. it promotes too easily. A gate that
    // quietly claims more precision than it has is the failure this repository opens its
    // constitution with.
    detail: `${n} round trips, mean ${first.estimate.toFixed(1)} bps, conservative interval [${lower.toFixed(1)}, ${upper.toFixed(1)}] bps vs zero (nominal ${(first.level * 100).toFixed(0)}%; measured coverage at this sample size is 79-93%, not 95%)`,
  };
}

export function promotionVerdict(input: PromotionInput): PromotionVerdict {
  const checks: PromotionCheck[] = [];

  // --- round trips -------------------------------------------------------
  // A baseline is identified by WHICH STRATEGY it is, never by whether this particular run happened
  // to sell. Keying on behaviour described a `ma-crossover` run that simply had not sold yet as one
  // that "never sells" — a claim about the strategy drawn from one run's luck.
  const required = input.requiredBaselines ?? BASELINE_STRATEGIES;
  const isBaseline = (required as readonly string[]).includes(input.strategyId);
  checks.push(isBaseline
    ? { id: 'round-trips', passed: false, detail: `${input.strategyId} is a baseline, not a promotion candidate` }
    : roundTripEvidence(input.roundTripReturnsBps));

  // --- coverage ----------------------------------------------------------
  if (input.coverage === undefined) {
    // Absence is not evidence of a full window; a run predating coverage stats cannot be promoted.
    checks.push({ id: 'coverage', passed: false, detail: 'coverage was not recorded for this run' });
  } else {
    const c = input.coverage;
    const covered = pct(c.candles, c.expectedBuckets);
    const gappy = pct(c.gapsOverBound, c.candles);
    const ok = covered >= MIN_COVERAGE_PCT && gappy <= MAX_GAPS_OVER_BOUND_PCT;
    checks.push({
      id: 'coverage',
      passed: ok,
      detail: `coverage ${covered.toFixed(1)}% of expected buckets (min ${MIN_COVERAGE_PCT}%), gaps over the stale-fill bound ${gappy.toFixed(1)}% of candles (max ${MAX_GAPS_OVER_BOUND_PCT}%)`,
    });
  }

  // --- comparable --------------------------------------------------------
  // Runs before returns: a return that beats an incomparable baseline is not evidence of anything,
  // and reporting it as a pass is worse than reporting nothing.
  const incomparable: string[] = [];
  if (input.context === undefined) {
    incomparable.push(`${input.strategyId}'s own run conditions were not recorded`);
  } else {
    for (const id of required) {
      const b = input.baselines.find((x) => x.strategyId === id);
      if (b === undefined) continue; // absence is the `measurable` check's business, not this one
      if (b.context === undefined) { incomparable.push(`${id}'s run conditions were not recorded`); continue; }
      if (b.context.baseUnit !== input.context.baseUnit) { incomparable.push(`${id} traded a different token`); continue; }
      const overlap = windowOverlap(input.context, b.context);
      if (overlap < MIN_WINDOW_OVERLAP) { incomparable.push(`${id}'s window overlaps only ${(overlap * 100).toFixed(0)}%`); continue; }
      const drift = capitalDrift(input.context, b.context);
      if (drift > MAX_CAPITAL_DRIFT) incomparable.push(`${id} started with ${(drift * 100).toFixed(1)}% different capital`);
    }
  }
  checks.push({
    id: 'comparable',
    passed: incomparable.length === 0,
    detail: incomparable.length === 0
      ? 'baselines match on token, window and starting capital'
      : `not comparable: ${incomparable.join('; ')}`,
  });

  // --- measurable --------------------------------------------------------
  const missing: string[] = [];
  if (input.returnBasePct === null) missing.push(`${input.strategyId}'s own token return`);
  for (const id of required) {
    const b = input.baselines.find((x) => x.strategyId === id);
    if (b === undefined) missing.push(`no ${id} run over this window`);
    else if (b.returnBasePct === null) missing.push(`${id}'s token return`);
  }
  checks.push({
    id: 'measurable',
    passed: missing.length === 0,
    detail: missing.length === 0 ? 'candidate and both baselines have a measurable token return' : `not measurable: ${missing.join('; ')}`,
  });

  // --- beats baselines ---------------------------------------------------
  // Strictly. A tie is not an edge, and it is certainly not one worth the risk of trading.
  const lost: string[] = [];
  if (input.returnBasePct !== null) {
    for (const id of required) {
      const b = input.baselines.find((x) => x.strategyId === id);
      if (b?.returnBasePct !== null && b !== undefined && !(input.returnBasePct > b.returnBasePct)) {
        lost.push(`${id} (${b.returnBasePct.toFixed(2)}%)`);
      }
    }
  }
  const canCompare = missing.length === 0 && incomparable.length === 0;
  checks.push({
    id: 'beats-baselines',
    passed: canCompare && lost.length === 0,
    detail: !canCompare
      ? 'not compared: a baseline is missing, unmeasurable, or not comparable'
      : lost.length === 0
        ? `beats both baselines in tokens (${input.returnBasePct!.toFixed(2)}%)`
        : `does not beat ${lost.join(' or ')} in tokens (${input.returnBasePct!.toFixed(2)}%)`,
  });

  const blockers = checks.filter((c) => !c.passed).map((c) => c.detail);
  return { status: blockers.length === 0 ? 'candidate' : 'experimental', checks, blockers };
}

/** Intersection over union of two windows, 0 when they do not overlap at all. */
function windowOverlap(a: RunContext, b: RunContext): number {
  const start = Math.max(a.windowFromMs, b.windowFromMs);
  const end = Math.min(a.windowToMs, b.windowToMs);
  const union = Math.max(a.windowToMs, b.windowToMs) - Math.min(a.windowFromMs, b.windowFromMs);
  if (union <= 0) return 0;
  return Math.max(0, end - start) / union;
}

/** |a - b| / max(a, b), so it is symmetric and cannot divide by a zero balance. */
function capitalDrift(a: RunContext, b: RunContext): number {
  const x = a.startEquityLovelace;
  const y = b.startEquityLovelace;
  const bigger = x > y ? x : y;
  if (bigger <= 0n) return 0;
  const diff = x > y ? x - y : y - x;
  return Number((diff * 1_000_000n) / bigger) / 1e6;
}
