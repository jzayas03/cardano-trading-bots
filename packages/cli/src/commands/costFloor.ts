import { createPool } from '@ctb/db';
import {
  costDistributions,
  costObservations,
  MIN_OBSERVATIONS,
  SIZE_BUCKETS_LOVELACE,
  type CostDistribution,
  type ExclusionRecord,
  type ThinPoolRecord,
  type ExclusionReason,
  type SnapshotInput,
} from '@ctb/reports';
import { cpmmAmountOut, tryCostsForPoolId, VENUE_COSTS, venueOf } from '@ctb/sim-executor';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

/**
 * `cost-floor [--min-observations N] [--sizes 100,250,500,1000,2500] [--since ISO] [--pool ID] [--json]`
 *
 * What does a round trip actually cost, per route and order size? Read-only; safe while a paper run
 * is live.
 *
 * The source is pool_snapshots, not fills, and that was forced by counting rather than chosen: only
 * 42 filled orders exist on measured venues in this project's history, at most 16 of which can form
 * a round trip. Against a 30-observation bar no bucket could ever qualify. Snapshots carry reserves
 * and fee_bps at a tick, which is the "contemporaneous quote" the M6 spec asked for, and there are
 * ~19,948 of them. See specs/002-cost-floor-distribution/research.md R1.
 *
 * This prints MODELLED cost, never realised. A quote priced through the curve captures the pool fee,
 * our own impact and the fixed venue fees. It captures none of batcher latency, the price moving
 * between submission and execution, partial fills, expiry, or adverse selection against a visible
 * order. Widening the sample improves an estimate of a modelled quantity; it does not turn paper
 * into live.
 */

/** D1: a venue whose cost cannot be measured is EXCLUDED from execution, not modelled with an
 *  invented penalty. Founder decision 2026-09-16, recorded in the spec's Decisions section. */
const POLICY_EXCLUSIONS: ReadonlyArray<[string, { reason: ExclusionReason; detail: string }]> = [
  ['Splash', { reason: 'varies-by-pool', detail: 'take varies BY POOL (2 ADA + ~1% on one pool, flat 2 on another); VENUE_COSTS is keyed by venue, so the KEY is wrong, not just the shape' }],
  ['VyFinance', { reason: 'unmeasured-fee', detail: 'orders go to a per-pool marketOrderAddress; never measured on chain' }],
  ['WingRiders', { reason: 'unmeasured-fee', detail: 'basis=assumed; batcher fee never read from a live datum' }],
  ['WingRidersV2', { reason: 'unmeasured-fee', detail: 'basis=assumed; batcher fee never read from a live datum' }],
  ['synthetic', { reason: 'not-a-market', detail: "the fill model's own pool id; generated data, not a venue" }],
  ['Fake', { reason: 'not-a-market', detail: 'dev:fake-collector rehearsal venue' }],
];

const DEFAULT_SINCE = '2026-09-06T00:00:00Z';
const LOVELACE = 1_000_000n;

export interface SnapshotRow {
  pool_id: string; base_unit: string; tick_ts: Date;
  reserve_base: string; reserve_quote: string; fee_bps: number; tvl_lovelace: string | null;
}

/**
 * Exported so the Postgres test pins THIS query rather than a copy of it. A test that pins its own
 * transcription proves the transcription, not the code.
 *
 * numeric is cast to text: these are lovelace and base subunits, and `Number` would lose them.
 * Filters: lovelace-quoted cpmm pools only, because the curve maths assumes both.
 */
export const SNAPSHOT_SQL = `SELECT pool_id, base_unit, tick_ts,
              reserve_base::text  AS reserve_base,
              reserve_quote::text AS reserve_quote,
              fee_bps,
              tvl_lovelace::text  AS tvl_lovelace
         FROM pool_snapshots
        WHERE tick_ts >= $1::timestamptz
          AND quote_unit = 'lovelace'
          AND pool_type = 'cpmm'
          AND ($2::text IS NULL OR pool_id = $2)
        ORDER BY pool_id, tick_ts`;

function arg(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function ada(lovelace: bigint): string {
  return (Number(lovelace / 1_000n) / 1000).toFixed(0);
}

function bps(n: number | null): string {
  return n === null ? '--' : n.toFixed(1);
}

/** Rendering kept apart from the numbers, so the numbers stay testable. */
export function renderCostFloor(
  distributions: readonly CostDistribution[],
  exclusions: readonly ExclusionRecord[],
  thinPools: readonly ThinPoolRecord[],
  provenance: {
    since: string;
    minObservations: number;
    sizes: readonly bigint[];
    firstTs: Date | null;
    lastTs: Date | null;
    venuesUsed: ReadonlyArray<{ venue: string; batcherAda: string; basis: string; readAt: string }>;
    minDepthAda: number;
  },
): string[] {
  const out: string[] = [];

  out.push('cost-floor: round-trip cost per route and order size');
  out.push('');
  out.push('PROVENANCE');
  out.push(`  figures are MODELLED, not realised: no batcher latency, no submit-to-execute price move,`);
  out.push(`  no partial fills, no expiry, no adverse selection. Realised cost is first measurable at`);
  out.push(`  the first funded trade (M6.5).`);
  out.push(`  snapshots since      ${provenance.since}`);
  out.push(
    `  observation window   ${provenance.firstTs ? provenance.firstTs.toISOString() : '--'} .. ${provenance.lastTs ? provenance.lastTs.toISOString() : '--'}`,
  );
  out.push(`  sufficiency bar      n >= ${provenance.minObservations} per (pool, size)`);
  out.push(`  size buckets (ADA)   ${provenance.sizes.map((s) => ada(s)).join(', ')}`);
  out.push(`  headline floor       p90 (founder decision D2: a floor is a cost you can survive)`);
  out.push(`  depth floor          ${provenance.minDepthAda} ADA a side, or the pool is not priced`);
  for (const v of provenance.venuesUsed) {
    out.push(`  venue ${v.venue.padEnd(14)} batcher ${v.batcherAda} ADA  basis=${v.basis}  readAt=${v.readAt}`);
  }
  out.push(`  NOTE the basis grade is read from the LIVE cost table, so it reflects what is known now.`);
  out.push('');

  const sufficient = distributions.filter((d) => d.verdict === 'sufficient');
  out.push(`ROUTES WITH ENOUGH OBSERVATIONS (${sufficient.length})`);
  if (sufficient.length === 0) {
    out.push('  none. No route reaches the sufficiency bar; that is a finding, not an error.');
  } else {
    out.push('  venue/pool                      size      n    p50    p75    p90=FLOOR  basis     med TVL');
    for (const d of sufficient) {
      out.push(
        `  ${`${d.poolId}`.padEnd(30)} ${ada(d.sizeBucketLovelace).padStart(5)}  ${String(d.n).padStart(5)}  ` +
          `${bps(d.p50).padStart(5)}  ${bps(d.p75).padStart(5)}  ${bps(d.p90).padStart(9)}  ${d.basis.padEnd(10)} ${ada(d.medianTvlLovelace)}`,
      );
    }
  }
  out.push('');

  const insufficient = distributions.filter((d) => d.verdict === 'insufficient');
  out.push(`NOT ENOUGH OBSERVATIONS TO SAY ANYTHING (${insufficient.length})`);
  for (const d of insufficient) {
    out.push(`  ${`${d.poolId}`.padEnd(30)} ${ada(d.sizeBucketLovelace).padStart(5)} ADA  n=${d.n} of ${provenance.minObservations} required`);
  }
  out.push('');

  // Never omitted, even when empty: the price of the exclusion policy must stay visible (FR-017).
  out.push(`EXCLUDED FROM EXECUTION (${exclusions.length})`);
  for (const e of exclusions) {
    out.push(`  ${e.venue.padEnd(16)} ${e.reason.padEnd(16)} ${e.snapshotsAvailable} snapshots given up`);
    out.push(`  ${''.padEnd(16)} ${e.detail}`);
  }
  out.push('');

  // Also never omitted. A pool dropped for depth has not been judged expensive; it has not been
  // judged at all, and those are different facts.
  out.push(`TOO THIN TO PRICE (${thinPools.length} pools, below ${provenance.minDepthAda} ADA a side)`);
  for (const t of thinPools) {
    out.push(`  ${t.poolId.slice(0, 40).padEnd(40)} median depth ${ada(t.medianDepthLovelace).padStart(9)} ADA  ${t.snapshotsDropped} snapshots`);
  }

  return out;
}

export async function costFloorCommand(log: Logger, args: readonly string[]): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: false });
  const since = arg(args, '--since') ?? DEFAULT_SINCE;
  const minObservations = Number(arg(args, '--min-observations') ?? MIN_OBSERVATIONS);
  const poolFilter = arg(args, '--pool') ?? null;
  const asJson = args.includes('--json');
  const sizes = arg(args, '--sizes')
    ? arg(args, '--sizes')!.split(',').map((s) => BigInt(s.trim()) * LOVELACE)
    : SIZE_BUCKETS_LOVELACE;

  if (!Number.isInteger(minObservations) || minObservations <= 0) throw new Error('--min-observations must be a positive integer');
  if (sizes.some((s) => s <= 0n)) throw new Error('--sizes must be positive ADA amounts');

  const pool = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'cost-floor pool error'));
  try {
    const rows = await pool.query<SnapshotRow>(SNAPSHOT_SQL, [since, poolFilter]);

    if (rows.rows.length === 0) {
      log.warn({ since }, 'no snapshots matched; nothing to measure');
      return;
    }

    const snapshots: SnapshotInput[] = rows.rows.map((r) => ({
      poolId: r.pool_id,
      baseUnit: r.base_unit,
      tickTs: r.tick_ts,
      reserveBase: BigInt(r.reserve_base),
      reserveQuote: BigInt(r.reserve_quote),
      feeBps: Number(r.fee_bps),
      tvlLovelace: BigInt(r.tvl_lovelace ?? '0'),
    }));

    // Reuses the project's existing depth threshold rather than inventing a second one: its own
    // justification ("a spread against a pool nobody can trade is not an opportunity") is exactly
    // the reason a 9-lovelace pool must not quote a 19,982 bps cost.
    const depthOverride = arg(args, '--min-depth-ada');
    if (depthOverride !== undefined && !(Number.isFinite(Number(depthOverride)) && Number(depthOverride) >= 0)) {
      throw new Error('--min-depth-ada must be a non-negative number');
    }
    const minDepthLovelace =
      depthOverride === undefined ? cfg.multiVenueMinDepthLovelace : BigInt(Math.round(Number(depthOverride))) * LOVELACE;
    const minDepthAda = Number(minDepthLovelace / LOVELACE);

    const { observations, exclusions, thinPools } = costObservations(
      snapshots,
      { cpmm: cpmmAmountOut, costsFor: tryCostsForPoolId, venueOf },
      { sizes, excludedVenues: new Map(POLICY_EXCLUSIONS), minDepthLovelace },
    );
    const distributions = costDistributions(observations, {
      minObservations,
      basisFor: (poolId) => tryCostsForPoolId(poolId)?.basis ?? 'assumed',
    });

    const times = observations.map((o) => o.tickTs.getTime());
    const venuesUsed = [...new Set(observations.map((o) => o.venue))].sort().map((venue) => {
      const c = VENUE_COSTS[venue as keyof typeof VENUE_COSTS];
      return { venue, batcherAda: c ? (Number(c.batcherFeeLovelace) / 1e6).toFixed(2) : '--', basis: c?.basis ?? '--', readAt: c?.readAt ?? '--' };
    });

    const provenance = {
      since,
      minObservations,
      sizes,
      firstTs: times.length ? new Date(Math.min(...times)) : null,
      lastTs: times.length ? new Date(Math.max(...times)) : null,
      venuesUsed,
      minDepthAda,
    };

    if (asJson) {
      console.log(JSON.stringify({ provenance, distributions, exclusions, thinPools }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    } else {
      for (const line of renderCostFloor(distributions, exclusions, thinPools, provenance)) console.log(line);
    }
    // Exit 0 whether or not anything is sufficient: "no route has enough data" is a finding.
  } finally {
    await pool.end();
  }
}
