import type { Pair } from '@ctb/universe';
import type { RunError, RunSummary, SnapshotRepo } from './repo.js';
import { bucketTick, poolIdOf, poolToSnapshot, reconcileTickTs } from './snapshot.js';
import type { DiscoveryCallsSource, PoolSource, RediscoverySource, SourceResult } from './source.js';
import type { Logger, SnapshotRow } from './types.js';

export interface CollectorState {
  lastDiscoveryAt: Date | null;
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
  source: PoolSource;
  repo: SnapshotRepo;
  pairs: Pair[];
  log: Logger;
  now: () => Date;
  intervalSec: number;
  rediscoverAfterMs: number;
  state: CollectorState;
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

  let result: SourceResult;
  try {
    result = stale ? await d.source.discover(d.pairs) : await d.source.refresh();
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
  if (!stale && hasRediscovery(d.source) && d.source.lostVenues().length > 0) {
    const lost = d.source.lostVenues();
    try {
      const again = await d.source.rediscover(d.pairs);
      result = { pools: [...result.pools, ...again.pools], failures: result.failures };
      errors.push(...again.failures);
      if (hasDiscoveryCalls(d.source)) summary.discoveryCalls = d.source.lastDiscoveryCalls();
      d.log.info({ venues: lost, pools: again.pools.length, stillLost: d.source.lostVenues() }, 'retried lost venues');
    } catch (err) {
      errors.push({ scope: 'rediscover', message: (err as Error).message ?? String(err) });
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
  return finish();
}
