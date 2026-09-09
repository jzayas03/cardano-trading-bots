import { withTransaction, type Db } from '@ctb/db';
import { utcMidnight, type DigestInput } from '@ctb/reports';
import type { TokenSpec } from '@ctb/universe';
import type { SnapshotRow } from './types.js';

export interface RunError {
  scope: string;
  message: string;
}

export interface RunSummary {
  poolsAttempted: number;
  poolsFailed: number;
  poolsWritten: number;
  providerCalls: number;
  discovered: boolean;
  /** Provider calls spent per venue on this tick's discovery, from a `DiscoveryCallsSource`-capable
   *  `PoolSource` (see source.ts). Null on a refresh tick (discovery didn't run) or when the source
   *  in use doesn't track this. */
  discoveryCalls: Record<string, number> | null;
  errors: RunError[];
}

export interface RunRow extends RunSummary {
  id: number;
  tickTs: Date;
  startedAt: Date;
  finishedAt: Date | null;
}

/** One row of `status`'s (and now the health page's) per-venue pool table at the newest tick. */
export interface VenuePoolCount {
  dex: string;
  pools: number;
  tickTs: Date;
}

export interface SnapshotRepo {
  syncTokens(tokens: TokenSpec[], seed: { seededAt: string; seedSource: string }): Promise<void>;
  startRun(tickTs: Date, startedAt: Date): Promise<number>;
  /** Returns rows actually inserted; (pool_id, tick_ts) duplicates are skipped, making a re-run of a tick safe. */
  insertSnapshots(runId: number, rows: SnapshotRow[]): Promise<number>;
  finishRun(runId: number, finishedAt: Date, summary: RunSummary): Promise<void>;
  lastRuns(limit: number): Promise<RunRow[]>;
}

/**
 * The restart-cost controls, kept OFF `SnapshotRepo` and probed structurally -- the same shape as
 * `DiscoveryCallsSource`/`RediscoverySource` in `source.ts`, and for the same reason: widening the
 * required interface would break every `SnapshotRepo` fake in the suite over a capability none of
 * them need. `PgSnapshotRepo` implements it; `runTick` checks for it.
 */
export interface PoolCacheRepo {
  restartState(now: Date): Promise<RestartState>;
  savePoolCache(pools: readonly CachedPool[], cachedAt: Date): Promise<void>;
}

/**
 * One pool exactly as discovery produced it. This is `LiquidityPoolShape` plus the id the rest of
 * the collector keys on -- deliberately the WHOLE shape, ordering and decimals included, because
 * Dexter matches a refreshed pool on `${dex}.${assetAName}/${assetBName}.${identifier}` and a
 * normalised copy would not match. See the migration's header comment.
 */
export interface CachedPool {
  poolId: string;
  dex: string;
  identifier: string;
  address: string;
  assetA: 'lovelace' | { policyId: string; nameHex: string; decimals: number };
  assetB: 'lovelace' | { policyId: string; nameHex: string; decimals: number };
  reserveA: bigint;
  reserveB: bigint;
  poolFeePercent: number;
}

/**
 * What a starting collector needs from the database so that a restart costs a refresh (~300 calls)
 * instead of a discovery sweep (~5,700). Both facts were already in the database and neither was
 * read: `lastDiscoveryAt` only fed the digest, and the pool set was not persisted at all.
 */
export interface RestartState {
  /** Newest finished discovery tick, or null if there has never been one. Seeds the rediscovery clock. */
  lastDiscoveryAt: Date | null;
  /** Provider calls already spent this UTC day, from `collector_runs`. A FLOOR: calls made by a tick
   *  that died before `finishRun`, and anything run by hand, are not in it. */
  callsSpentToday: number;
  /** Provider calls the most recent discovery sweep actually cost, used to price the next one. */
  lastDiscoveryCost: number | null;
  /** The persisted pool set, newest cache write. Empty when the cache has never been written. */
  pools: CachedPool[];
}

/** Placeholders per snapshot row (run_id + 14 pool_snapshots columns). Went 14 -> 15 when
 *  `is_primary` was added (migration 0009): every placeholder is numbered off this, so a stale
 *  value shifts every column by one. */
const PARAMS_PER_ROW = 15;

export class PgSnapshotRepo implements SnapshotRepo, PoolCacheRepo {
  constructor(private readonly db: Db) {}

  async syncTokens(tokens: TokenSpec[], seed: { seededAt: string; seedSource: string }): Promise<void> {
    for (const t of tokens) {
      await this.db.query(
        `INSERT INTO tokens (unit, policy_id, asset_name_hex, ticker, decimals, category, seeded_at, seed_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (unit) DO UPDATE SET ticker = EXCLUDED.ticker, decimals = EXCLUDED.decimals, category = EXCLUDED.category`,
        [t.unit, t.policyId, t.assetNameHex, t.ticker, t.decimals, t.category, seed.seededAt, seed.seedSource],
      );
    }
  }

  async startRun(tickTs: Date, startedAt: Date): Promise<number> {
    const res = await this.db.query<{ id: string }>(
      'INSERT INTO collector_runs (tick_ts, started_at) VALUES ($1, $2) RETURNING id',
      [tickTs, startedAt],
    );
    const id = res.rows[0]?.id;
    if (id === undefined) throw new Error('startRun returned no id');
    return Number(id);
  }

  async insertSnapshots(runId: number, rows: SnapshotRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(
        runId, r.tickTs, r.dex, r.poolId, r.poolAddress, r.baseUnit, r.quoteUnit,
        r.reserveBase.toString(), r.reserveQuote.toString(), r.feeBps, r.poolType,
        r.tvlLovelace.toString(), r.blockHeight, r.observedAt, r.isPrimary,
      );
      const p = Array.from({ length: PARAMS_PER_ROW }, (_, k) => `$${i * PARAMS_PER_ROW + k + 1}`);
      return `(${p.join(', ')})`;
    });
    const res = await this.db.query(
      `INSERT INTO pool_snapshots (run_id, tick_ts, dex, pool_id, pool_address, base_unit, quote_unit,
         reserve_base, reserve_quote, fee_bps, pool_type, tvl_lovelace, block_height, observed_at, is_primary)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (pool_id, tick_ts) DO NOTHING`,
      values,
    );
    return res.rowCount ?? 0;
  }

  async finishRun(runId: number, finishedAt: Date, s: RunSummary): Promise<void> {
    await this.db.query(
      `UPDATE collector_runs SET finished_at = $2, pools_attempted = $3, pools_failed = $4, pools_written = $5,
         provider_calls = $6, discovered = $7, errors = $8::jsonb, discovery_calls = $9::jsonb WHERE id = $1`,
      [
        runId, finishedAt, s.poolsAttempted, s.poolsFailed, s.poolsWritten, s.providerCalls, s.discovered,
        JSON.stringify(s.errors), s.discoveryCalls === null ? null : JSON.stringify(s.discoveryCalls),
      ],
    );
  }

  async lastRuns(limit: number): Promise<RunRow[]> {
    const res = await this.db.query<{
      id: string; tick_ts: Date; started_at: Date; finished_at: Date | null; pools_attempted: number; pools_failed: number;
      pools_written: number; provider_calls: number; discovered: boolean; errors: RunError[];
      discovery_calls: Record<string, number> | null;
    }>('SELECT * FROM collector_runs ORDER BY id DESC LIMIT $1', [limit]);
    return res.rows.map((r) => ({
      id: Number(r.id), tickTs: r.tick_ts, startedAt: r.started_at, finishedAt: r.finished_at,
      poolsAttempted: r.pools_attempted, poolsFailed: r.pools_failed, poolsWritten: r.pools_written,
      providerCalls: r.provider_calls, discovered: r.discovered, errors: r.errors,
      discoveryCalls: r.discovery_calls ?? null,
    }));
  }

  /**
   * The three restart-cost facts in one round trip. Read once at startup, before the first tick.
   *
   * `callsSpentToday` counts `provider_calls` ALONE. `discovery_calls` is the per-venue BREAKDOWN of
   * that same number, not an addend -- summing both double-counts every discovery tick, which is a
   * mistake this project has already made once and acted on.
   */
  async restartState(now: Date): Promise<RestartState> {
    const agg = await this.db.query<{ last_discovery: Date | null; spent_today: string; last_discovery_cost: string | null }>(
      `SELECT
         (SELECT max(started_at) FROM collector_runs WHERE discovered AND finished_at IS NOT NULL) AS last_discovery,
         (SELECT coalesce(sum(provider_calls), 0) FROM collector_runs WHERE started_at >= $1::timestamptz) AS spent_today,
         (SELECT provider_calls FROM collector_runs WHERE discovered AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1) AS last_discovery_cost`,
      [utcMidnight(now)],
    );
    const a = agg.rows[0]!;
    const cache = await this.db.query<{
      pool_id: string; dex: string; identifier: string; address: string;
      asset_a: CachedPool['assetA']; asset_b: CachedPool['assetB'];
      reserve_a: string; reserve_b: string; pool_fee_percent: number;
    }>('SELECT pool_id, dex, identifier, address, asset_a, asset_b, reserve_a, reserve_b, pool_fee_percent FROM collector_pool_cache ORDER BY pool_id');
    return {
      lastDiscoveryAt: a.last_discovery,
      callsSpentToday: Number(a.spent_today),
      lastDiscoveryCost: a.last_discovery_cost === null ? null : Number(a.last_discovery_cost),
      pools: cache.rows.map((r) => ({
        poolId: r.pool_id, dex: r.dex, identifier: r.identifier, address: r.address,
        assetA: r.asset_a, assetB: r.asset_b,
        reserveA: BigInt(r.reserve_a), reserveB: BigInt(r.reserve_b),
        poolFeePercent: r.pool_fee_percent,
      })),
    };
  }

  /**
   * Replaces the cache with exactly `pools`, in one transaction. Replace and not upsert: a pool that
   * discovery no longer finds must LEAVE the cache, or a restart would resurrect a pool that has
   * been delisted and spend a refresh call per tick failing on it forever.
   *
   * An empty `pools` is refused rather than obeyed. Emptying the cache is indistinguishable at read
   * time from never having written one, and it would silently reinstate the very bug this closes.
   */
  async savePoolCache(pools: readonly CachedPool[], cachedAt: Date): Promise<void> {
    if (pools.length === 0) throw new Error('refusing to empty the pool cache: an empty cache reads as "no cache" and restores the restart-costs-a-sweep bug');
    await withTransaction(this.db, async (tx) => {
      await tx.query('DELETE FROM collector_pool_cache');
      for (const p of pools) {
        await tx.query(
          `INSERT INTO collector_pool_cache (pool_id, dex, identifier, address, asset_a, asset_b, reserve_a, reserve_b, pool_fee_percent, cached_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
          [p.poolId, p.dex, p.identifier, p.address, JSON.stringify(p.assetA), JSON.stringify(p.assetB),
            p.reserveA.toString(), p.reserveB.toString(), p.poolFeePercent, cachedAt],
        );
      }
    });
  }

  /** The digest's inputs, from `collector_runs` only. Pure aggregation, no writes. */
  async digestInput(intervalSec: number, venuesConfigured: string[], now: Date): Promise<DigestInput> {
    const last = await this.db.query<{ tick_ts: Date; finished_at: Date; pools_written: number; pools_failed: number; provider_calls: number; discovered: boolean }>(
      'SELECT tick_ts, finished_at, pools_written, pools_failed, provider_calls, discovered FROM collector_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
    );
    const agg = await this.db.query<{ ticks_24h: string; discovery_calls_today: string; refresh_calls_today: string; failures_24h: string; errors_24h: string; unfinished: string; last_discovery: Date | null; tokens_total: string; tokens_covered: string }>(
      `SELECT
         (SELECT count(DISTINCT tick_ts) FROM collector_runs WHERE finished_at IS NOT NULL AND tick_ts > $1::timestamptz - interval '24 hours') AS ticks_24h,
         -- A refresh tick that retried a lost venue carries that scan's calls in discovery_calls (jsonb
         -- per venue): count them as one-off discovery cost, not as recurring refresh, or a returning
         -- MinswapV2 (~3,300 calls) projects as tens of thousands of refresh calls per day.
         (SELECT coalesce(sum(provider_calls), 0) FROM collector_runs WHERE started_at >= $2::timestamptz AND discovered)
           + (SELECT coalesce(sum(v.calls), 0) FROM collector_runs r, LATERAL (SELECT sum(value::int) AS calls FROM jsonb_each_text(r.discovery_calls)) v
              WHERE r.started_at >= $2::timestamptz AND NOT r.discovered AND r.discovery_calls IS NOT NULL) AS discovery_calls_today,
         (SELECT coalesce(sum(provider_calls), 0) FROM collector_runs WHERE started_at >= $2::timestamptz AND NOT discovered)
           - (SELECT coalesce(sum(v.calls), 0) FROM collector_runs r, LATERAL (SELECT sum(value::int) AS calls FROM jsonb_each_text(r.discovery_calls)) v
              WHERE r.started_at >= $2::timestamptz AND NOT r.discovered AND r.discovery_calls IS NOT NULL) AS refresh_calls_today,
         (SELECT count(*) FROM tokens) AS tokens_total,
         (SELECT count(DISTINCT base_unit) FROM pool_snapshots WHERE tick_ts = (SELECT max(tick_ts) FROM pool_snapshots)) AS tokens_covered,
         (SELECT coalesce(sum(pools_failed), 0) FROM collector_runs WHERE tick_ts > $1::timestamptz - interval '24 hours') AS failures_24h,
         (SELECT coalesce(sum(jsonb_array_length(errors)), 0) FROM collector_runs WHERE tick_ts > $1::timestamptz - interval '24 hours') AS errors_24h,
         (SELECT count(*) FROM collector_runs WHERE finished_at IS NULL AND started_at > $1::timestamptz - interval '24 hours') AS unfinished,
         (SELECT max(tick_ts) FROM collector_runs WHERE discovered AND finished_at IS NOT NULL) AS last_discovery`,
      [now, utcMidnight(now)],
    );
    const venues = await this.db.query<{ dex: string }>('SELECT DISTINCT dex FROM pool_snapshots WHERE tick_ts = (SELECT max(tick_ts) FROM pool_snapshots) ORDER BY dex');
    // "Since" not "at": a venue lost at discovery and brought back by a later tick's retry has its
    // snapshots on that later tick, and must stop reading as lost from then on.
    const discoveryVenues = await this.db.query<{ dex: string }>(
      'SELECT DISTINCT dex FROM pool_snapshots WHERE tick_ts >= (SELECT max(tick_ts) FROM collector_runs WHERE discovered AND finished_at IS NOT NULL) ORDER BY dex',
    );
    const a = agg.rows[0]!;
    const l = last.rows[0];
    return {
      intervalSec,
      lastFinished: l ? { tickTs: l.tick_ts, finishedAt: l.finished_at, poolsWritten: l.pools_written, poolsFailed: l.pools_failed, providerCalls: l.provider_calls, discovered: l.discovered } : null,
      ticksLast24h: Number(a.ticks_24h), discoveryCallsToday: Number(a.discovery_calls_today), refreshCallsToday: Number(a.refresh_calls_today), lastDiscoveryAt: a.last_discovery,
      venuesConfigured, venuesSinceLastDiscovery: discoveryVenues.rows.map((r) => r.dex), venuesInLastTick: venues.rows.map((r) => r.dex), tokensTotal: Number(a.tokens_total), tokensCoveredInLastTick: Number(a.tokens_covered),
      poolFailures24h: Number(a.failures_24h), venueErrors24h: Number(a.errors_24h), unfinishedRuns: Number(a.unfinished),
    };
  }

  /** Per-venue pool counts at the newest tick (moved verbatim from `status`'s own inline query, spec
   *  §4.2: `status` and the dashboard's health page must render the identical numbers from the
   *  identical call — see `oneRule.guard.test.ts`/`readOnly.guard.test.ts`). */
  async perVenuePoolCounts(): Promise<VenuePoolCount[]> {
    const res = await this.db.query<{ dex: string; pools: string; tick_ts: Date }>(
      `SELECT dex, count(*) AS pools, tick_ts FROM pool_snapshots
       WHERE tick_ts = (SELECT max(tick_ts) FROM pool_snapshots) GROUP BY dex, tick_ts ORDER BY dex`,
    );
    return res.rows.map((r) => ({ dex: r.dex, pools: Number(r.pools), tickTs: r.tick_ts }));
  }

  /** Approximate count of ticks missed in the last 24h, moved verbatim from `status`'s own inline
   *  query (same reasoning as `perVenuePoolCounts` above). `null` when the aggregate query returns no
   *  row at all (should not happen in practice — `t` always produces one aggregate row — but mirrors
   *  `status`'s own `?? 'n/a'` fallback rather than assuming a row is always present). */
  async missingTicksApprox(intervalSec: number): Promise<string | null> {
    const res = await this.db.query<{ missing_ticks: string }>(
      `WITH t AS (SELECT DISTINCT tick_ts FROM collector_runs WHERE tick_ts > now() - interval '24 hours')
       SELECT (extract(epoch FROM (now() - (now() - interval '24 hours'))) / $1::int)::int - count(*) AS missing_ticks FROM t`,
      [intervalSec],
    );
    return res.rows[0]?.missing_ticks ?? null;
  }
}
