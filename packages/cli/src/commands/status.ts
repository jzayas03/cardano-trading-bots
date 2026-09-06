import { PgSnapshotRepo } from '@ctb/collector';
import { createPool } from '@ctb/db';
import { PgRunRepo, type RunningRun } from '@ctb/engine';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

/** A paper run's own `params.intervalSec`/`params.graceSec` when present and numeric; the `paper`
 * command's own defaults otherwise, for a run row that predates those params or lost them. */
const DEFAULT_INTERVAL_SEC = 300;
const DEFAULT_GRACE_SEC = 60;

/**
 * A running paper process only proves it is alive through its heartbeat. `2 * intervalSec +
 * graceSec` is the same bound `liveCandleFeed` uses to decide a tick is late — one missed tick is
 * normal jitter, two is a process an operator should look at. A run that has never heartbeated is
 * treated as STALE too, not as age 0.
 */
function heartbeatAgeColumn(r: RunningRun, params: Record<string, unknown>, now: number): number | string {
  const intervalSec = typeof params.intervalSec === 'number' ? params.intervalSec : DEFAULT_INTERVAL_SEC;
  const graceSec = typeof params.graceSec === 'number' ? params.graceSec : DEFAULT_GRACE_SEC;
  const staleAfterMs = (2 * intervalSec + graceSec) * 1000;
  if (!r.heartbeatAt) return 'STALE';
  const ageMs = now - r.heartbeatAt.getTime();
  return ageMs > staleAfterMs ? 'STALE' : Math.round(ageMs / 1000);
}

export async function statusCommand(log: Logger): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: false });
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const repo = new PgSnapshotRepo(db);
    const runs = await repo.lastRuns(10);
    const perDex = await db.query<{ dex: string; pools: string; tick_ts: Date }>(
      `SELECT dex, count(*) AS pools, tick_ts FROM pool_snapshots
       WHERE tick_ts = (SELECT max(tick_ts) FROM pool_snapshots) GROUP BY dex, tick_ts ORDER BY dex`,
    );
    const gaps = await db.query<{ missing_ticks: string }>(
      `WITH t AS (SELECT DISTINCT tick_ts FROM collector_runs WHERE tick_ts > now() - interval '24 hours')
       SELECT (extract(epoch FROM (now() - (now() - interval '24 hours'))) / $1::int)::int - count(*) AS missing_ticks FROM t`,
      [cfg.intervalSec],
    );
    // Plain output is intended here: status is an operator command, not a request path.
    console.table(runs.map((r) => ({
      id: r.id, tick: r.tickTs.toISOString(), finished: r.finishedAt ? 'yes' : 'NO', attempted: r.poolsAttempted,
      written: r.poolsWritten, failed: r.poolsFailed, calls: r.providerCalls, discovered: r.discovered, errors: r.errors.length,
    })));
    console.table(perDex.rows.map((r) => ({ dex: r.dex, pools: Number(r.pools), tick: r.tick_ts.toISOString() })));
    console.log(`ticks missing in last 24h (approx): ${gaps.rows[0]?.missing_ticks ?? 'n/a'}`);

    const paperRepo = new PgRunRepo(db);
    const running = await paperRepo.listRunning();
    const universe = await loadUniverse();
    const now = Date.now();
    // Few rows at most (running paper processes, not request volume) — one getRun per row for its
    // params is fine; listRunning() itself doesn't carry params.
    const paperRows = await Promise.all(running.map(async (r) => {
      const full = await paperRepo.getRun(r.id);
      return {
        id: r.id, strategy: r.strategyId, ticker: universe.tokens.find((t) => t.unit === r.baseUnit)?.ticker ?? r.baseUnit,
        rehearsal: r.rehearsal, 'heartbeat age (s)': heartbeatAgeColumn(r, full?.params ?? {}, now),
        'last tick': r.lastTickTs ? r.lastTickTs.toISOString() : '-', created: r.createdAt.toISOString(),
      };
    }));
    console.log('\npaper runs:');
    if (paperRows.length) console.table(paperRows); else console.log('(none running)');
  } finally {
    await db.end();
  }
}
