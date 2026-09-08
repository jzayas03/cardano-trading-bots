import type { Pair } from '@ctb/universe';
import type { PoolCacheRepo, RunError, RunSummary, SnapshotRepo } from './repo.js';
import { bucketTick, poolIdOf, poolToSnapshot, reconcileTickTs } from './snapshot.js';
import type { DiscoveryCallsSource, HydratableSource, PoolSource, RediscoverySource, SourceResult } from './source.js';
import type { Logger, SnapshotRow } from './types.js';

export interface CollectorState {
  lastDiscoveryAt: Date | null;
  /**
   * Provider calls spent so far this UTC day. Seeded from `collector_runs` at startup and advanced
   * by every tick, so the budget survives a restart instead of resetting to zero with the process.
   * A FLOOR: calls made by a tick that died before `finishRun` are not in the seed.
   */
  callsSpentToday: number;
  /** The UTC day (`YYYY-MM-DD`) `callsSpentToday` refers to. Compared on every tick so the rollover
   *  is an explicit reset rather than something inferred from a timestamp comparison. */
  spendDay: string;
  /** What the most recent discovery sweep actually cost, used to price the next one. Null until one
   *  has been observed, when `DEFAULT_DISCOVERY_COST` stands in. */
  lastDiscoveryCost: number | null;
}

/** The UTC calendar day of `at`, as `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * What to assume a discovery sweep costs before one has been measured on this database. The real
 * figure on 2026-09-08 was 5,691-5,692 across six venues; rounding UP is the safe direction, because
 * this number only ever gates whether a sweep is affordable.
 */
export const DEFAULT_DISCOVERY_COST = 6_000;

/**
 * A `CollectorState` for a process with nothing persisted to start from. The `collect` command seeds
 * the real one from `restartState()`; tests and one-off ticks use this.
 */
export function freshState(now: Date): CollectorState {
  return { lastDiscoveryAt: null, callsSpentToday: 0, spendDay: utcDay(now), lastDiscoveryCost: null };
}

/** True when `source` also implements `DiscoveryCallsSource` (currently only `DexterPoolSource`).
 *  Checked structurally, not via `PoolSource` itself, so every existing `PoolSource` fake keeps
 *  working unchanged — see the doc comment on `DiscoveryCallsSource` in source.ts. */
function hasDiscoveryCalls(source: PoolSource): source is PoolSource & DiscoveryCallsSource {
  // `PoolSource` and `DiscoveryCallsSource` share no property, so TS's "weak type" check (TS2559)
  // refuses a direct `Partial<DiscoveryCallsSource>` assignment as a likely typo; routing through
  // `unknown` is the standard way to structurally probe for an optional capability like this one.
  const maybe = source as unknown as Partial<DiscoveryCallsSource>;
  return typeof maybe.lastDiscoveryCalls === 'function';
}

/** Same structural probe for the optional hydration capability (only `DexterPoolSource` today). */
function isHydratable(source: PoolSource): source is PoolSource & HydratableSource {
  const maybe = source as unknown as Partial<HydratableSource>;
  return typeof maybe.hydrate === 'function' && typeof maybe.cachedPools === 'function';
}

/** Same structural probe for the optional rediscovery capability (only `DexterPoolSource` today). */
function hasRediscovery(source: PoolSource): source is PoolSource & RediscoverySource {
  const maybe = source as unknown as Partial<RediscoverySource>;
  return typeof maybe.lostVenues === 'function' && typeof maybe.rediscover === 'function';
}

/**
 * True for a per-pool failure: `refresh:<poolId>` (always per-pool) or `discover:<venue>:<identifier>`
 * (a pool-mapping failure within a venue). False for a venue-level `discover:<venue>` failure — the
 * whole venue's fetch failed, so no individual pool was ever attempted.
 */
export function isPoolFailure(err: RunError): boolean {
  return err.scope.startsWith('refresh:') || /^discover:[^:]+:./.test(err.scope);
}

export interface TickDeps {
  /** Refresh only these base units this tick. Omit for every known pool. Lets the traded token be
   * sampled far more often than the rest inside one Blockfrost budget. */
  refreshOnly?: ReadonlySet<string>;
  source: PoolSource;
  repo: SnapshotRepo;
  pairs: Pair[];
  log: Logger;
  now: () => Date;
  intervalSec: number;
  rediscoverAfterMs: number;
  state: CollectorState;
  /**
   * Refuse a discovery sweep when the day's spend plus the sweep's expected cost would exceed this
   * many provider calls. 0 disables the check.
   *
   * This is the blast-radius bound, not the fix. The fix is that a restart hydrates its pool set and
   * so does not ask for a sweep at all; this catches every OTHER way a sweep can be asked for when
   * the quota cannot pay -- a crash loop, a genuinely empty universe, a hand-run tick. Refusing is
   * fail-closed in the honest direction: the tick writes nothing and says why on the run row, which
   * is recoverable, where spending the day's last 6,000 calls is not.
   */
  dailyCallCeiling: number;
  /** Persists the pool set after a discovery. Omit and the cache is simply not written -- the
   *  collector still works, it just pays for a sweep on the next restart. */
  poolCache?: PoolCacheRepo;
  /**
   * The tick bucket to write, pinned by the caller. The `collect` loop computes the boundary it is
   * about to sleep toward BEFORE sleeping and passes it back in here; if the tick were instead
   * bucketed from `now()` after an early wake, it could land one bucket EARLIER than the boundary
   * actually slept for. Omitted for the immediate (non-boundary) first tick, which still derives
   * from `now()`. Reconciled here against the clock, so a boundary that went stale while the caller
   * was suspended is moved FORWARD to the bucket the tick is really in — see `reconcileTickTs`.
   */
  tickTs?: Date;
}

/**
 * One collector tick. Source failures are recorded on the run row, never thrown, so the loop keeps going
 * and the gap is visible in `collector_runs`. Only repository failures propagate.
 */
export async function runTick(d: TickDeps): Promise<RunSummary> {
  const startedAt = d.now();
  // The spend counter belongs to a UTC day, and Blockfrost's quota resets at 00:00 UTC. Reset here,
  // before the budget check reads it, so the first tick of a new day is not refused on yesterday's
  // spend -- which is exactly the tick a restart-free day most needs to be allowed to discover.
  const today = utcDay(startedAt);
  if (d.state.spendDay !== today) {
    d.state.spendDay = today;
    d.state.callsSpentToday = 0;
  }
  // A caller-pinned boundary is reconciled against the clock: it may be stale if the caller's sleep
  // overshot (a suspended machine), and `reconcileTickTs` never moves it earlier. Applied here
  // rather than in the collect loop so every caller of runTick gets it, not just that one.
  const tickTs = d.tickTs ? reconcileTickTs(d.tickTs, startedAt, d.intervalSec) : bucketTick(startedAt, d.intervalSec);
  const runId = await d.repo.startRun(tickTs, startedAt);
  d.source.resetProviderCalls();
  const errors: RunError[] = [];
  const summary: RunSummary = {
    poolsAttempted: 0, poolsFailed: 0, poolsWritten: 0, providerCalls: 0, discovered: false, discoveryCalls: null, errors,
  };

  const finish = async (): Promise<RunSummary> => {
    summary.providerCalls = d.source.providerCalls();
    d.state.callsSpentToday += summary.providerCalls;
    if (summary.discovered) d.state.lastDiscoveryCost = summary.providerCalls;
    await d.repo.finishRun(runId, d.now(), summary);
    d.log.info({ runId, tickTs, ...summary, errors: summary.errors.length }, 'tick finished');
    return summary;
  };

  let tip: { height: number; time: Date };
  try {
    tip = await d.source.tip();
  } catch (err) {
    errors.push({ scope: 'tip', message: (err as Error).message ?? String(err) });
    return finish();
  }

  const stale =
    d.state.lastDiscoveryAt === null ||
    d.source.knownPoolCount() === 0 ||
    startedAt.getTime() - d.state.lastDiscoveryAt.getTime() > d.rediscoverAfterMs;

  // The sweep is priced BEFORE it is run, against the day's spend. Refusing here rather than inside
  // `discover` keeps the decision on the run row: the tick finishes, writes nothing, and says why.
  if (stale && d.dailyCallCeiling > 0) {
    const cost = d.state.lastDiscoveryCost ?? DEFAULT_DISCOVERY_COST;
    const projected = d.state.callsSpentToday + cost;
    if (projected > d.dailyCallCeiling) {
      const message = `discovery refused: ${d.state.callsSpentToday} calls spent today + ~${cost} for a sweep = ${projected}, over the ${d.dailyCallCeiling} ceiling`;
      errors.push({ scope: 'budget', message });
      d.log.warn({ runId, spentToday: d.state.callsSpentToday, sweepCost: cost, ceiling: d.dailyCallCeiling }, message);
      return finish();
    }
  }

  let result: SourceResult;
  try {
    result = stale ? await d.source.discover(d.pairs) : await d.source.refresh(d.refreshOnly);
  } catch (err) {
    errors.push({ scope: stale ? 'discover' : 'refresh', message: (err as Error).message ?? String(err) });
    return finish();
  }
  if (stale) {
    summary.discovered = true;
    d.state.lastDiscoveryAt = startedAt;
    // Null stays on a refresh tick (discovery didn't run) and on a discover tick against a PoolSource
    // that doesn't track this (e.g. an older test fake) — only a discover tick against a capable
    // source (DexterPoolSource in production) gets the real per-venue counts.
    if (hasDiscoveryCalls(d.source)) summary.discoveryCalls = d.source.lastDiscoveryCalls();
  }
  errors.push(...result.failures);

  // A venue lost at discovery is tried again on every later tick until it returns, instead of
  // waiting for the next full discovery. Its pools are written with this tick; its per-venue call
  // counts go on the row so the digest can tell a one-off scan from recurring refresh cost.
  let setChangedByRediscovery = false;
  if (!stale && hasRediscovery(d.source) && d.source.lostVenues().length > 0) {
    const lost = d.source.lostVenues();
    try {
      const again = await d.source.rediscover(d.pairs);
      setChangedByRediscovery = again.pools.length > 0;
      result = { pools: [...result.pools, ...again.pools], failures: result.failures };
      errors.push(...again.failures);
      if (hasDiscoveryCalls(d.source)) summary.discoveryCalls = d.source.lastDiscoveryCalls();
      d.log.info({ venues: lost, pools: again.pools.length, stillLost: d.source.lostVenues() }, 'retried lost venues');
    } catch (err) {
      errors.push({ scope: 'rediscover', message: (err as Error).message ?? String(err) });
    }
  }

  // The known set changed this tick, so persist it: this is what makes the NEXT restart cost a
  // refresh instead of a sweep. A save failure is recorded and swallowed -- the tick's snapshots are
  // worth more than the cache, and the only cost of a missing cache is one sweep later.
  if ((stale || setChangedByRediscovery) && isHydratable(d.source) && d.poolCache) {
    const pools = d.source.cachedPools();
    if (pools.length > 0) {
      try {
        await d.poolCache.savePoolCache(pools, startedAt);
        d.log.info({ runId, pools: pools.length }, 'pool cache written');
      } catch (err) {
        errors.push({ scope: 'poolCache', message: (err as Error).message ?? String(err) });
      }
    }
  }

  const rows: SnapshotRow[] = [];
  summary.poolsAttempted = result.pools.length + result.failures.filter(isPoolFailure).length;
  for (const pool of result.pools) {
    try {
      rows.push(poolToSnapshot(pool, { tickTs, blockHeight: tip.height, observedAt: d.now() }));
    } catch (err) {
      errors.push({ scope: `map:${poolIdOf(pool)}`, message: (err as Error).message ?? String(err) });
    }
  }
  summary.poolsFailed = summary.poolsAttempted - rows.length;
  summary.poolsWritten = await d.repo.insertSnapshots(runId, rows);
  // attempted = written + failed, or something was dropped between mapping and the database and
  // NOTHING else would say so. `insertSnapshots` is ON CONFLICT DO NOTHING on (pool_id, tick_ts),
  // so a row silently disappears whenever this tick's bucket already holds that pool — which is
  // exactly what happened at the M5 cutover: the restored dump carried the old host's 19:30 tick,
  // and the new host's 20 MinswapV2 rows for the same bucket vanished into a run row that read
  // `88 attempted, 0 failed, 68 written` and looked clean.
  //
  // That instance was benign. The point is that a harmful one would look identical.
  const unaccounted = summary.poolsAttempted - summary.poolsWritten - summary.poolsFailed;
  if (unaccounted !== 0) {
    d.log.warn(
      { runId, tickTs, attempted: summary.poolsAttempted, written: summary.poolsWritten, failed: summary.poolsFailed, unaccounted },
      'pool accounting does not reconcile; rows were dropped on insert (usually this tick already had snapshots for those pools)',
    );
  }
  return finish();
}
