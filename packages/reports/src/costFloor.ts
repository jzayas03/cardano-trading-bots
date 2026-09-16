/**
 * Round-trip cost as a DISTRIBUTION per route and order size, not a single number.
 *
 * Why this module exists: the constitution states the floor as settled ("216 bps, and it is
 * measured") while docs/specs/2026-09-08-m6-execution.md 2.1 records that the figure is ONE paper
 * fill and the OPTIMISTIC reading. 216 is not wrong; it is n=1. See specs/002-cost-floor-distribution.
 *
 * PURITY. This file imports nothing at runtime outside its own package. The curve is INJECTED
 * rather than imported, and that is not fastidiousness: `@ctb/sim-executor` re-exports
 * `@ctb/collector/pure`, which re-exports `PgSnapshotRepo`, so importing it loads `pg` -- proven by
 * probe, `pg` lands in require.cache. Worse, `packages/collector/src/repo.ts` imports `@ctb/reports`,
 * so a runtime edge from here to sim-executor closes a cycle. The purity guard is a source-text
 * regex and would have caught neither. `import type` is erased, so the type import below adds no
 * runtime edge.
 *
 * THE ARITHMETIC, stated once so it can be checked. For notional N lovelace on reserves
 * (rQuote, rBase) with pool fee feeBps:
 *   1. idealBase = N * rBase / rQuote      -- what N buys AT MID: no fee, no impact
 *   2. outBase   = cpmm(N, rQuote, rBase, feeBps)
 *   3. oneWayBps = (idealBase - outBase)/idealBase   -- pool fee AND own impact, fee-inclusive
 *   4. impactBps = 2 * oneWayBps           -- a round trip is two one-way legs
 *   5. fixedFeeBps = 2*(batcher + network)/N
 *   6. roundTripBps = impactBps + fixedFeeBps
 *
 * WHY ONE WAY, DOUBLED, rather than pricing a there-and-back through the pool. An immediate
 * buy-then-sell through the SAME pool returns you to the same point on the curve, so own price
 * impact CANCELS EXACTLY: measured here at fee=0, a 50,000 ADA round trip into a 100,000 ADA pool
 * costs 0.000000 bps. With a fee it gets CHEAPER as size grows (59.85 bps at 100 ADA down to 40.02
 * at 50,000), because the favourable price displacement from the buy partly offsets the sell's fee.
 * That is a real property of a self-reversing trade and a useless model of trading: a strategy buys
 * at t and sells at t+k against reserves that have moved, so the two impacts do not cancel. Doubling
 * the one-way cost is also exactly the structure docs/specs/2026-09-08-m6-execution.md 2.1 uses to
 * get 216 from 108. The first version of this module priced the there-and-back; the monotonicity
 * test caught it, which is the whole reason that test exists.
 *
 * ASSUMPTION worth naming: the sell leg is modelled as symmetric to the buy leg at the same
 * notional against the same reserves. The real sell happens at a different time and size. This is
 * the same assumption 2.1 makes by doubling, and it is why the output is MODELLED, not realised.
 *
 * What is NOT in that sum and must NEVER be added to it: `slippageBps` and `priceImpactBps` as
 * computed at fill time. Both already contain the pool fee, and so does curveLossBps. Adding any of
 * them charges the pool fee two or three times. A 2026-09-09 summary did exactly that, charging the
 * fee twice and inventing a spread term. Step 4 REPLACES those measures; it does not combine them.
 */
import type { VenueCosts } from '@ctb/sim-executor';
import { quantile } from './opportunity.js';

/** The constant-product swap, injected. Signature matches `cpmmAmountOut` exactly. */
export type CurveFn = (amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number) => bigint;

const LOVELACE = 1_000_000n;

/**
 * Order sizes priced, in LOVELACE NOTIONAL. Fixed here, before any run, so they cannot later be
 * chosen to flatter a result.
 *
 * Notional, never `amount_in`: on a buy `amount_in` is lovelace, on a sell it is base-token
 * subunits (simExecutor.ts:131). Bucketing on the raw column mixes two units, which is Principle II
 * and the mistake that already cost this project three months of mis-denominated candles.
 */
export const SIZE_BUCKETS_LOVELACE: readonly bigint[] = [
  100n * LOVELACE,   // the OLD MIN_BUY_LOVELACE; kept as a bucket because it shows why it moved
  250n * LOVELACE,
  500n * LOVELACE,   // MIN_BUY_LOVELACE since 2026-09-16, and scheduledAccumulation's buyAda
  1_000n * LOVELACE, // ~ the 990 ADA of run 139, the fill 216 bps came from
  2_500n * LOVELACE, // impact should dominate the fixed fee here
];

/** Default sufficiency bar, matching the promotion gate's MIN_ROUND_TRIPS for internal consistency. */
export const MIN_OBSERVATIONS = 30;

export interface SnapshotInput {
  poolId: string;
  baseUnit: string;
  tickTs: Date;
  reserveBase: bigint;
  reserveQuote: bigint;
  feeBps: number;
  tvlLovelace: bigint;
}

export interface CostObservation {
  poolId: string;
  venue: string;
  sizeBucketLovelace: bigint;
  tickTs: Date;
  roundTripBps: number;
  impactBps: number;
  fixedFeeBps: number;
  tvlLovelace: bigint;
  source: 'quote' | 'fill';
}

export type ExclusionReason = 'unmeasured-fee' | 'varies-by-pool' | 'no-snapshots' | 'not-a-market';

export interface ExclusionRecord {
  venue: string;
  reason: ExclusionReason;
  detail: string;
  snapshotsAvailable: number;
}

/**
 * A pool dropped for being too thin to price, recorded per POOL rather than per venue because
 * depth is a property of the pool and varies over time. Never silently dropped: the first real run
 * showed a pool with a median TVL of 9 lovelace quoting 19,982 bps, and a figure like that is an
 * artefact, not a cost. Constitution Principle III: a quoted price is not a market.
 */
export interface ThinPoolRecord {
  poolId: string;
  venue: string;
  snapshotsDropped: number;
  medianDepthLovelace: bigint;
  requiredLovelace: bigint;
}

export interface CostDistribution {
  poolId: string;
  venue: string;
  sizeBucketLovelace: bigint;
  verdict: 'sufficient' | 'insufficient';
  n: number;
  firstTs: Date;
  lastTs: Date;
  /** null whenever `verdict === 'insufficient'`. The null is in the DATA, not the formatter. */
  p50: number | null;
  p75: number | null;
  p90: number | null;
  floorBps: number | null;
  basis: VenueCosts['basis'];
  medianTvlLovelace: bigint;
}

export type FloorAnswer =
  | { kind: 'floor'; bps: number; basis: VenueCosts['basis']; n: number; asOf: Date }
  | { kind: 'insufficient'; n: number; required: number }
  | { kind: 'excluded'; venue: string; reason: ExclusionReason };

export interface CostObservationDeps {
  /** The real `cpmmAmountOut`. Injected; see the purity note above. */
  cpmm: CurveFn;
  /** Resolved venue costs, or null for a venue not in the table. Usually `tryCostsForPoolId`. */
  costsFor: (poolId: string) => VenueCosts | null;
  /** Usually `venueOf`. Injected for the same reason as the curve. */
  venueOf: (poolId: string) => string;
}

export interface CostObservationOptions {
  sizes?: readonly bigint[];
  /** Venues excluded by policy before any pricing (D1). */
  excludedVenues?: ReadonlyMap<string, { reason: ExclusionReason; detail: string }>;
  /**
   * Minimum ADA-side reserve for a snapshot to be worth pricing. Defaults to 0, meaning no filter;
   * the CLI supplies the project's existing `COLLECT_MULTI_VENUE_MIN_DEPTH_ADA`, whose own
   * justification is the same one that applies here -- "a spread against a pool nobody can trade is
   * not an opportunity". Reusing that threshold beats inventing a second one.
   */
  minDepthLovelace?: bigint;
}

/** bps to three decimals, from exact bigint arithmetic. `Number(x)/1e6` is banned in this package. */
function bpsOf(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return Number.NaN;
  return Number((numerator * 10_000_000n) / denominator) / 1000;
}

function medianBigint(values: readonly bigint[]): bigint {
  if (values.length === 0) return 0n;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)]!;
}

/**
 * One observation per (snapshot, size bucket). A snapshot that cannot be priced yields NO
 * observation -- never an Infinity one, and never a fallback cost. An unknown venue is a rejection,
 * matching SimExecutor, where an unknown venue is refused rather than charged a default.
 */
export function costObservations(
  snapshots: readonly SnapshotInput[],
  deps: CostObservationDeps,
  opts: CostObservationOptions = {},
): { observations: CostObservation[]; exclusions: ExclusionRecord[]; thinPools: ThinPoolRecord[] } {
  const sizes = opts.sizes ?? SIZE_BUCKETS_LOVELACE;
  const excluded = opts.excludedVenues ?? new Map<string, { reason: ExclusionReason; detail: string }>();
  const minDepth = opts.minDepthLovelace ?? 0n;
  const observations: CostObservation[] = [];
  const excludedCounts = new Map<string, number>();
  const noCostVenues = new Map<string, number>();
  const thin = new Map<string, { venue: string; depths: bigint[] }>();

  for (const s of snapshots) {
    const venue = deps.venueOf(s.poolId);

    const policy = excluded.get(venue);
    if (policy) {
      excludedCounts.set(venue, (excludedCounts.get(venue) ?? 0) + 1);
      continue;
    }

    const costs = deps.costsFor(s.poolId);
    if (!costs) {
      noCostVenues.set(venue, (noCostVenues.get(venue) ?? 0) + 1);
      continue;
    }

    // cpmmAmountOut throws on non-positive reserves; refuse before calling rather than catching.
    if (s.reserveBase <= 0n || s.reserveQuote <= 0n) continue;
    if (!Number.isInteger(s.feeBps) || s.feeBps < 0 || s.feeBps >= 10_000) continue;

    // Too thin to price. Recorded, not silently dropped.
    if (s.reserveQuote < minDepth) {
      const t = thin.get(s.poolId) ?? { venue, depths: [] };
      t.depths.push(s.reserveQuote);
      thin.set(s.poolId, t);
      continue;
    }

    const fixed = (costs.batcherFeeLovelace + costs.networkFeeLovelace) * 2n;

    for (const notional of sizes) {
      if (notional <= 0n) continue;
      const outBase = deps.cpmm(notional, s.reserveQuote, s.reserveBase, s.feeBps);
      // A buy that would drain the pool is not a trade; no observation rather than a vast number.
      if (outBase <= 0n || outBase >= s.reserveBase) continue;

      // What the notional would buy AT MID -- no fee, no impact. The shortfall against it is the
      // one-way cost, and it contains the pool fee (cpmm applied feeBps) plus our own curve impact.
      const idealBase = (notional * s.reserveBase) / s.reserveQuote;
      if (idealBase <= 0n || outBase >= idealBase) continue;

      const oneWayBps = bpsOf(idealBase - outBase, idealBase);
      const impactBps = 2 * oneWayBps;
      const fixedFeeBps = bpsOf(fixed, notional);
      observations.push({
        poolId: s.poolId,
        venue,
        sizeBucketLovelace: notional,
        tickTs: s.tickTs,
        roundTripBps: impactBps + fixedFeeBps,
        impactBps,
        fixedFeeBps,
        tvlLovelace: s.tvlLovelace,
        source: 'quote',
      });
    }
  }

  const exclusions: ExclusionRecord[] = [];
  // EVERY policy-excluded venue is listed, including those with zero snapshots. Listing only the
  // ones that happened to appear in the data makes "excluded by policy" indistinguishable from
  // "never collected", and FR-017 exists so the price of the exclusion policy stays visible. Found
  // by the first real run: VyFinance and Splash have no snapshots at all, so they vanished from the
  // report entirely and a reader would have concluded the policy did not apply to them.
  for (const [venue, policy] of excluded) {
    exclusions.push({
      venue,
      reason: excludedCounts.has(venue) ? policy.reason : 'no-snapshots',
      detail: excludedCounts.has(venue)
        ? policy.detail
        : `${policy.detail} -- and no snapshots were collected for it in this window`,
      snapshotsAvailable: excludedCounts.get(venue) ?? 0,
    });
  }
  for (const [venue, count] of noCostVenues) {
    exclusions.push({
      venue,
      reason: 'unmeasured-fee',
      detail: 'no VENUE_COSTS entry; an unknown venue is refused, never charged a default',
      snapshotsAvailable: count,
    });
  }
  exclusions.sort((a, b) => a.venue.localeCompare(b.venue));

  const thinPools: ThinPoolRecord[] = [...thin.entries()]
    .map(([poolId, t]) => ({
      poolId,
      venue: t.venue,
      snapshotsDropped: t.depths.length,
      medianDepthLovelace: medianBigint(t.depths),
      requiredLovelace: minDepth,
    }))
    .sort((a, b) => a.venue.localeCompare(b.venue) || a.poolId.localeCompare(b.poolId));

  return { observations, exclusions, thinPools };
}

export interface CostDistributionOptions {
  minObservations?: number;
  basisFor?: (poolId: string) => VenueCosts['basis'];
}

/**
 * Grouped by (poolId, sizeBucket). There is deliberately NO venue-level aggregate: a single global
 * floor is not computed here, so it cannot be printed by accident downstream.
 */
export function costDistributions(
  observations: readonly CostObservation[],
  opts: CostDistributionOptions = {},
): CostDistribution[] {
  const min = opts.minObservations ?? MIN_OBSERVATIONS;
  const groups = new Map<string, CostObservation[]>();
  for (const o of observations) {
    const key = `${o.poolId}@${o.sizeBucketLovelace}`;
    const g = groups.get(key);
    if (g) g.push(o);
    else groups.set(key, [o]);
  }

  const out: CostDistribution[] = [];
  for (const g of groups.values()) {
    const first = g[0]!;
    const values = g.map((o) => o.roundTripBps);
    const times = g.map((o) => o.tickTs.getTime());
    const sufficient = g.length >= min;
    const p90 = sufficient ? quantile(values, 0.9) : null;
    out.push({
      poolId: first.poolId,
      venue: first.venue,
      sizeBucketLovelace: first.sizeBucketLovelace,
      verdict: sufficient ? 'sufficient' : 'insufficient',
      n: g.length,
      firstTs: new Date(Math.min(...times)),
      lastTs: new Date(Math.max(...times)),
      p50: sufficient ? quantile(values, 0.5) : null,
      p75: sufficient ? quantile(values, 0.75) : null,
      p90,
      floorBps: p90,
      basis: opts.basisFor?.(first.poolId) ?? 'assumed',
      medianTvlLovelace: medianBigint(g.map((o) => o.tvlLovelace)),
    });
  }

  out.sort(
    (a, b) =>
      a.venue.localeCompare(b.venue) ||
      a.poolId.localeCompare(b.poolId) ||
      (a.sizeBucketLovelace < b.sizeBucketLovelace ? -1 : a.sizeBucketLovelace > b.sizeBucketLovelace ? 1 : 0),
  );
  return out;
}

/**
 * Fails closed. Three cases and no fourth: there is deliberately no code path returning a number
 * when the data is missing. M6 7 requires fail-closed, and a silent fallback to 216 is precisely
 * the behaviour this feature exists to remove.
 */
export function lookupFloor(
  distributions: readonly CostDistribution[],
  exclusions: readonly ExclusionRecord[],
  poolId: string,
  notionalLovelace: bigint,
  sizes: readonly bigint[] = SIZE_BUCKETS_LOVELACE,
  minObservations: number = MIN_OBSERVATIONS,
): FloorAnswer {
  const forPool = distributions.filter((d) => d.poolId === poolId);
  if (forPool.length === 0) {
    const venue = poolId.split(':')[0] ?? '';
    const ex = exclusions.find((e) => e.venue === venue);
    // An unknown pool is EXCLUDED, not insufficient. They are different facts.
    return { kind: 'excluded', venue, reason: ex?.reason ?? 'no-snapshots' };
  }

  // Round UP to the next bucket: the more conservative answer. Above the top bucket we refuse
  // rather than extrapolate the largest bucket's figure.
  const bucket = [...sizes].sort((a, b) => (a < b ? -1 : 1)).find((s) => s >= notionalLovelace);
  if (bucket === undefined) return { kind: 'insufficient', n: 0, required: minObservations };

  const d = forPool.find((x) => x.sizeBucketLovelace === bucket);
  if (!d) return { kind: 'insufficient', n: 0, required: minObservations };
  if (d.verdict === 'insufficient' || d.floorBps === null) {
    return { kind: 'insufficient', n: d.n, required: minObservations };
  }
  return { kind: 'floor', bps: d.floorBps, basis: d.basis, n: d.n, asOf: d.lastTs };
}
