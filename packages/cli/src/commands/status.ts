import { PgSnapshotRepo } from '@ctb/collector';
import { createPool } from '@ctb/db';
import { PgRunRepo } from '@ctb/engine';
import { heartbeatAgeCell, isHeartbeatStale } from '@ctb/reports';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { digestLines, type DigestInput, utcMidnight } from '../digest.js';

export { heartbeatAgeCell, isHeartbeatStale };

const USAGE = 'usage: status [--digest]';

export function parseStatusArgs(args: string[]): { digest: boolean } {
  const out = { digest: false };
  for (const a of args) {
    if (a === '--digest') out.digest = true;
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return out;
}

/** The digest's inputs, from `collector_runs` only. Exported for the pg test; pure aggregation, no writes. */
export async function loadDigestInput(db: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> }, intervalSec: number, venuesConfigured: string[], now: Date): Promise<DigestInput> {
  const last = await db.query<{ tick_ts: Date; finished_at: Date; pools_written: number; pools_failed: number; provider_calls: number; discovered: boolean }>(
    'SELECT tick_ts, finished_at, pools_written, pools_failed, provider_calls, discovered FROM collector_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
  );
  const agg = await db.query<{ ticks_24h: string; discovery_calls_today: string; refresh_calls_today: string; failures_24h: string; errors_24h: string; unfinished: string; last_discovery: Date | null; tokens_total: string; tokens_covered: string }>(
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
  const venues = await db.query<{ dex: string }>('SELECT DISTINCT dex FROM pool_snapshots WHERE tick_ts = (SELECT max(tick_ts) FROM pool_snapshots) ORDER BY dex');
  // "Since" not "at": a venue lost at discovery and brought back by a later tick's retry has its
  // snapshots on that later tick, and must stop reading as lost from then on.
  const discoveryVenues = await db.query<{ dex: string }>(
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

export async function statusCommand(log: Logger, args: string[] = []): Promise<void> {
  const { digest } = parseStatusArgs(args);
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
    if (digest) {
      // The morning screen: the digest lines replace the ten-row run table, everything else stays.
      const now = new Date();
      console.log(`=== digest ${now.toISOString()}`);
      for (const line of digestLines(await loadDigestInput(db, cfg.intervalSec, [...cfg.venues], now), now)) console.log(line);
    } else console.table(runs.map((r) => ({
      id: r.id, tick: r.tickTs.toISOString(), finished: r.finishedAt ? 'yes' : 'NO', attempted: r.poolsAttempted,
      written: r.poolsWritten, failed: r.poolsFailed, calls: r.providerCalls, discovered: r.discovered, errors: r.errors.length,
    })));
    console.table(perDex.rows.map((r) => ({ dex: r.dex, pools: Number(r.pools), tick: r.tick_ts.toISOString() })));
    console.log(`ticks missing in last 24h (approx): ${gaps.rows[0]?.missing_ticks ?? 'n/a'}`);

    // `runs` is already ordered newest-first; find the latest discovery tick that actually recorded
    // per-venue counts (a refresh tick, or a row from before migration 0005, carries null instead).
    const latestDiscovery = runs.find((r) => r.discoveryCalls && Object.keys(r.discoveryCalls).length > 0);
    if (latestDiscovery?.discoveryCalls && !digest) {
      const topVenues = Object.entries(latestDiscovery.discoveryCalls)
        .sort(([, a], [, b]) => b - a)
        .map(([venue, calls]) => ({ venue, calls }));
      console.log(`\ntop venues by calls (discovery tick ${latestDiscovery.tickTs.toISOString()}):`);
      console.table(topVenues);
    }

    const paperRepo = new PgRunRepo(db);
    const running = await paperRepo.listRunning();
    const universe = await loadUniverse();
    const now = new Date();
    // Few rows at most (running paper processes, not request volume) — one getRun per row for its
    // params is fine; listRunning() itself doesn't carry params.
    const paperRows = await Promise.all(running.map(async (r) => {
      const full = await paperRepo.getRun(r.id);
      return {
        id: r.id, strategy: r.strategyId, ticker: universe.tokens.find((t) => t.unit === r.baseUnit)?.ticker ?? r.baseUnit,
        rehearsal: r.rehearsal, 'heartbeat age (s)': heartbeatAgeCell(r.heartbeatAt, full?.params ?? {}, now),
        'last tick': r.lastTickTs ? r.lastTickTs.toISOString() : '-', created: r.createdAt.toISOString(),
      };
    }));
    console.log('\npaper runs:');
    if (paperRows.length) console.table(paperRows); else console.log('(none running)');
  } finally {
    await db.end();
  }
}
