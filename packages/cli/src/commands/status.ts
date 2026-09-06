import { PgSnapshotRepo } from '@ctb/collector';
import { createPool } from '@ctb/db';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

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
  } finally {
    await db.end();
  }
}
