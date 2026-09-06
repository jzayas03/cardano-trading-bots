import type { Pair } from '@ctb/universe';
import type { RunError, RunSummary, SnapshotRepo } from './repo.js';
import { bucketTick, poolIdOf, poolToSnapshot } from './snapshot.js';
import type { PoolSource } from './source.js';
import type { Logger, SnapshotRow } from './types.js';

export interface CollectorState {
  lastDiscoveryAt: Date | null;
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
}

/**
 * One collector tick. Source failures are recorded on the run row, never thrown, so the loop keeps going
 * and the gap is visible in `collector_runs`. Only repository failures propagate.
 */
export async function runTick(d: TickDeps): Promise<RunSummary> {
  const startedAt = d.now();
  const tickTs = bucketTick(startedAt, d.intervalSec);
  const runId = await d.repo.startRun(tickTs, startedAt);
  d.source.resetProviderCalls();
  const errors: RunError[] = [];
  const summary: RunSummary = { poolsAttempted: 0, poolsFailed: 0, poolsWritten: 0, providerCalls: 0, discovered: false, errors };

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

  const result = stale ? await d.source.discover(d.pairs) : await d.source.refresh();
  if (stale) {
    summary.discovered = true;
    d.state.lastDiscoveryAt = startedAt;
  }
  errors.push(...result.failures);

  const rows: SnapshotRow[] = [];
  summary.poolsAttempted = result.pools.length + result.failures.filter((f) => f.scope.startsWith('refresh:')).length;
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
