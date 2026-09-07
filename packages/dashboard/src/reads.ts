/**
 * The SELECT-only queries the existing repos don't already provide (spec §4.3). `PgDashboardReads`
 * is the concrete read-only class backing `DashboardDeps.reads`; Task 4 wired the interface with a
 * literal `{ listRuns: async () => [] }` stub so the router could be built and tested before this
 * landed. Task 5's brief scoped this file to `listRuns` only (the runs list and detail pages need
 * nothing else); this task (M4c, `/universe`) adds the three spec §4.3 names that page needs —
 * `latestSnapshotsPerToken`, `snapshotAt` (as `snapshotsAt`, plural — see its own comment), and
 * `externalCoverageAll`. `runsSharingGrid` is still left for whichever task adds the page that needs
 * it.
 */
import type { Queryable } from '@ctb/db';
import { rowToRun, type RunRow, type RunsRowRaw } from '@ctb/engine';

/** The enum values `mode`/`status` accept, exported so the router (query-string validation) and
 * `pages/runs.ts` (the filter form's `<select>` options) read from one place instead of each
 * hard-coding its own copy that can drift from the other. */
export const RUN_MODES = ['backtest', 'paper'] as const;
export const RUN_STATUSES = ['running', 'finished', 'aborted'] as const;

export interface RunFilter {
  mode?: (typeof RUN_MODES)[number];
  /** `runs.strategy_id`. Freeform: no fixed enum exists (a strategy can be added without a migration). */
  strategy?: string;
  /** `runs.base_unit` — the raw asset unit, not a ticker. The router resolves a `?ticker=` query
   * value to a unit (via the universe) before it ever reaches this filter; this package has no
   * notion of tickers itself. */
  unit?: string;
  status?: (typeof RUN_STATUSES)[number];
}

/** One pool snapshot row, already the DEEPEST pool for its token at whatever tick the query picked —
 * `latestSnapshotsPerToken`/`snapshotsAt` never return more than one row per `unit`. Numeric columns
 * (`pool_snapshots.reserve_base`/`reserve_quote`/`tvl_lovelace` are all `numeric(38,0)`) come back
 * from `pg` as strings and are converted to `bigint` here, the same boundary `@ctb/candles`'s
 * `readSnapshotsSince` already crosses for the identical columns. */
export interface TokenSnapshot {
  unit: string;
  dex: string;
  poolId: string;
  tickTs: Date;
  reserveBase: bigint;
  reserveQuote: bigint;
  feeBps: number;
  tvlLovelace: bigint;
}

/** One row per `unit` that has an `external_pool_map` entry — a unit with none (no mapped external
 * pool at all) simply has no row here, which `pages/universe.ts` reads as "0 rows, no dates" rather
 * than fetching a default. Mirrors `PgExternalRepo.coverage`'s per-unit shape (`@ctb/candles`), just
 * for every mapped unit in one query instead of one unit at a time. */
export interface ExternalCoverage {
  unit: string;
  rows: number;
  first: Date | null;
  last: Date | null;
}

export interface DashboardReads {
  /** Newest first, per spec §3 ("nothing is sorted by return"); `limit`/`offset` bound every call. */
  listRuns(filter: RunFilter, limit: number, offset: number): Promise<RunRow[]>;

  /** The deepest pool per token AT the newest `tick_ts` in `pool_snapshots` — a token whose only
   * snapshot is older than that tick (the collector missed it, or the token was added after) is
   * simply ABSENT from the result, never padded in with a stale row. One query: the newest `tick_ts`
   * as a subquery, `DISTINCT ON (base_unit)` breaking ties the same way `buildCandles` does — largest
   * `tvl_lovelace`, then smallest `pool_id` (see `TOKEN_SNAPSHOT_SELECT`'s own comment for why this is
   * `tvl_lovelace`, not `reserve_quote`). */
  latestSnapshotsPerToken(): Promise<TokenSnapshot[]>;

  /** The deepest pool per token at the newest `tick_ts` that is `<= at` AND `>= at - withinMs` — a
   * per-token lookup done in one query, so a gap in one token's collection degrades to that token's
   * own nearest older tick inside the window rather than to nothing, while a different token with no
   * gap still reads its own true newest-before-`at` tick. A token with no snapshot at all inside the
   * window is absent from the result. */
  snapshotsAt(at: Date, withinMs: number): Promise<TokenSnapshot[]>;

  /** One row per unit with an `external_pool_map` entry — `rows`/`first`/`last` describe the
   * `candles_external` history for the pool currently mapped, exactly like `PgExternalRepo.coverage`
   * (`@ctb/candles`) computes it for one unit, but for every mapped unit at once. */
  externalCoverageAll(): Promise<ExternalCoverage[]>;
}

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

/**
 * MINOR (final review): spec §4.3 says "no page issues a query without a `LIMIT` except the digest's
 * own aggregates" — `latestSnapshotsPerToken`, `snapshotsAt` and `externalCoverageAll` below are none
 * of those (they are `/universe`'s reads, not the digest's), yet none of them carried a literal
 * `LIMIT`. They are still STRUCTURALLY bounded without one: `DISTINCT ON (base_unit)` caps the first
 * two to one row per distinct `base_unit` in `pool_snapshots`, and `GROUP BY m.base_unit` caps the
 * third to one row per distinct `base_unit` in `external_pool_map` — both tables' row counts track the
 * 20-token universe (`packages/universe/universe.json`), not request volume. A literal `LIMIT` doesn't
 * change what any of the three can return today, but it satisfies the spec's own wording literally
 * rather than resting on an argument a future reader has to re-derive from the schema, and gives each
 * query a hard ceiling if this package is ever pointed at a database whose `base_unit` cardinality has
 * grown far past any conceivable token universe. Chosen generously (50x the current universe size, not
 * tuned to it) so ordinary growth of the token list never needs this constant revisited.
 */
const UNIVERSE_QUERY_LIMIT = 1000;

interface TokenSnapshotRaw {
  base_unit: string;
  dex: string;
  pool_id: string;
  tick_ts: Date;
  reserve_base: string;
  reserve_quote: string;
  fee_bps: number;
  tvl_lovelace: string;
}

function rowToTokenSnapshot(r: TokenSnapshotRaw): TokenSnapshot {
  return {
    unit: r.base_unit, dex: r.dex, poolId: r.pool_id, tickTs: r.tick_ts,
    reserveBase: BigInt(r.reserve_base), reserveQuote: BigInt(r.reserve_quote),
    feeBps: r.fee_bps, tvlLovelace: BigInt(r.tvl_lovelace),
  };
}

/** Shared by `latestSnapshotsPerToken` and `snapshotsAt`: one row per `base_unit`, the deepest pool
 * at whichever `tick_ts` the caller's `WHERE` clause admits — `DISTINCT ON (base_unit)` keeps the
 * FIRST row per group under this exact `ORDER BY`, so sorting by `tick_ts DESC` first (newest
 * qualifying tick wins), then `tvl_lovelace DESC, pool_id` (deepest pool at THAT tick, ties broken the
 * same way) picks exactly the row spec §4.3 describes.
 *
 * MINOR (fix round, finding 6): this used to tie-break on `reserve_quote DESC` — the same figure
 * `pages/universe.ts` displays as "depth ADA" — while `packages/candles/src/build.ts`'s `buildCandles`
 * picks its own deepest pool by `tvlLovelace DESC, poolId` (see that file's own sort, right after it
 * throws on a non-cpmm/zero-reserve row). The two orderings agreed only because the collector always
 * writes `tvl_lovelace = 2 * reserve_quote` (`packages/collector/src/snapshot.ts`'s `SnapshotRow`
 * construction) — a multiplication by a positive constant never changes which row sorts first, so the
 * two columns were always equivalent orderings in practice, but nothing here PINNED that: a future
 * pool type with a different tvl/reserve relationship (a stableswap curve, a concentrated-liquidity
 * position sized asymmetrically) would silently make this query's "deepest" pool disagree with the
 * candle builder's, while every existing test — built on the same invariant — kept passing. Ordering
 * by `tvl_lovelace` directly, the identical column `buildCandles` sorts by, removes the dependency on
 * that invariant rather than merely documenting it: this query and the candle builder now agree by
 * construction, for any future pool type, not only for the CPMM shape the invariant happens to hold
 * for today. */
const TOKEN_SNAPSHOT_SELECT = `SELECT DISTINCT ON (base_unit) base_unit, dex, pool_id, tick_ts, reserve_base, reserve_quote, fee_bps, tvl_lovelace
     FROM pool_snapshots`;

export class PgDashboardReads implements DashboardReads {
  constructor(private readonly q: Queryable) {}

  /**
   * WHERE clauses are added only for the filter keys actually present, each its own parameter —
   * never string-interpolated. `limit` is clamped to [1, 500] so a caller (or a malformed `?page=`
   * upstream) can never turn this into an unbounded scan (spec §3, "always bounded").
   */
  async listRuns(filter: RunFilter, limit: number, offset: number): Promise<RunRow[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    const addClause = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      values.push(value);
      clauses.push(`${column} = $${values.length}`);
    };
    addClause('mode', filter.mode);
    addClause('strategy_id', filter.strategy);
    addClause('base_unit', filter.unit);
    addClause('status', filter.status);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const clampedLimit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    values.push(clampedLimit);
    const limitParam = `$${values.length}`;
    values.push(safeOffset);
    const offsetParam = `$${values.length}`;

    const res = await this.q.query<RunsRowRaw>(
      `SELECT * FROM runs ${where} ORDER BY id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`, values);
    return res.rows.map(rowToRun);
  }

  /**
   * Zero parameters: the "newest tick" bound is a subquery against `pool_snapshots` itself, not a
   * caller-supplied value, so a token whose latest row sits on an OLDER tick than the table's global
   * newest is correctly excluded rather than padded in — that is the whole point of "AT the newest
   * tick_ts", per spec §4.3 and the M4c brief's own fixture (a token with two pools on the newest
   * tick proves the tie-break; a token whose only snapshot predates it proves the exclusion).
   */
  async latestSnapshotsPerToken(): Promise<TokenSnapshot[]> {
    const res = await this.q.query<TokenSnapshotRaw>(
      `${TOKEN_SNAPSHOT_SELECT}
      WHERE tick_ts = (SELECT max(tick_ts) FROM pool_snapshots)
      ORDER BY base_unit, tvl_lovelace DESC, pool_id
      LIMIT ${UNIVERSE_QUERY_LIMIT}`,
    );
    return res.rows.map(rowToTokenSnapshot);
  }

  /**
   * `at`/`withinMs` are bound straight into `values` — never inspected or dereferenced in this
   * method's own TypeScript (no `.getTime()`, no arithmetic on either), so the read-only guard's
   * reflective invocation (`GENERIC_SAFE_ARGS`, which hands this method `{}` for `at` and `1` for
   * `withinMs`, not a real `Date`) can drive it without throwing. All the actual date arithmetic is
   * Postgres's: `tick_ts <= $1` and `tick_ts >= $1 - ($2 * interval '1 millisecond')` compute the
   * lower bound server-side from whatever `$2` (milliseconds) says, so a caller never has to hand this
   * method an already-subtracted Date for the window floor — only the target `at` itself.
   *
   * `DISTINCT ON (base_unit)` here does two jobs from one `ORDER BY`: "newest qualifying tick_ts wins"
   * (per-token — a gap in ONE token's collection does not affect another token's own newest-before-
   * `at` tick) and, among snapshots sharing that tick_ts, "deepest pool wins", exactly like
   * `latestSnapshotsPerToken` above.
   */
  async snapshotsAt(at: Date, withinMs: number): Promise<TokenSnapshot[]> {
    const res = await this.q.query<TokenSnapshotRaw>(
      `${TOKEN_SNAPSHOT_SELECT}
      WHERE tick_ts <= $1 AND tick_ts >= $1 - ($2 * interval '1 millisecond')
      ORDER BY base_unit, tick_ts DESC, tvl_lovelace DESC, pool_id
      LIMIT ${UNIVERSE_QUERY_LIMIT}`,
      [at, withinMs],
    );
    return res.rows.map(rowToTokenSnapshot);
  }

  /**
   * One row per unit that has ever been matched to an external pool, regardless of whether any
   * candle has actually been imported for it yet (`LEFT JOIN`: `count`/`min`/`max` over zero matching
   * `candles_external` rows read as `0`/`null`/`null`, not as "no row at all" — spec's "0 rows, - dates"
   * for a mapped-but-empty unit, distinct from a NEVER-mapped unit, which has no row here at all and
   * is `pages/universe.ts`'s job to render the same way). Joined on the full mapped-pool key
   * (`base_unit, source, external_pool_id`) — the same three columns `PgExternalRepo`'s own
   * `MAPPED_POOL_JOIN` (`@ctb/candles`) uses — so a token with two historical `external_pool_id`s
   * (a re-pin) counts only the rows of the pool currently mapped, never both stitched together.
   */
  async externalCoverageAll(): Promise<ExternalCoverage[]> {
    const res = await this.q.query<{ unit: string; rows: string; first: Date | null; last: Date | null }>(
      `SELECT m.base_unit AS unit, count(ce.tick_ts) AS rows, min(ce.tick_ts) AS first, max(ce.tick_ts) AS last
         FROM external_pool_map m
         LEFT JOIN candles_external ce
           ON ce.base_unit = m.base_unit AND ce.source = m.source AND ce.external_pool_id = m.external_pool_id
        GROUP BY m.base_unit
        LIMIT ${UNIVERSE_QUERY_LIMIT}`,
    );
    return res.rows.map((r) => ({ unit: r.unit, rows: Number(r.rows), first: r.first, last: r.last }));
  }
}
