import { PgSnapshotRepo } from '@ctb/collector/pure';
import { createPool } from '@ctb/db';
import { PgRunRepo } from '@ctb/engine';
import { heartbeatAgeCell, isHeartbeatStale } from '@ctb/reports';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { digestLines } from '../digest.js';

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

export async function statusCommand(log: Logger, args: string[] = []): Promise<void> {
  const { digest } = parseStatusArgs(args);
  const cfg = loadConfig(process.env, { blockfrost: false });
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const repo = new PgSnapshotRepo(db);
    const runs = await repo.lastRuns(10);
    // Moved onto PgSnapshotRepo (verbatim SQL) so the dashboard's health page can call the exact same
    // methods and never drift from what this command prints — see @ctb/collector's repo.ts.
    const perDex = await repo.perVenuePoolCounts();
    const missingTicks = await repo.missingTicksApprox(cfg.intervalSec);
    // Plain output is intended here: status is an operator command, not a request path.
    if (digest) {
      // The morning screen: the digest lines replace the ten-row run table, everything else stays.
      const now = new Date();
      console.log(`=== digest ${now.toISOString()}`);
      for (const line of digestLines(await repo.digestInput(cfg.intervalSec, [...cfg.venues], now), now)) console.log(line);
    } else console.table(runs.map((r) => ({
      id: r.id, tick: r.tickTs.toISOString(), finished: r.finishedAt ? 'yes' : 'NO', attempted: r.poolsAttempted,
      written: r.poolsWritten, failed: r.poolsFailed, calls: r.providerCalls, discovered: r.discovered, errors: r.errors.length,
    })));
    console.table(perDex.map((r) => ({ dex: r.dex, pools: r.pools, tick: r.tickTs.toISOString() })));
    console.log(`ticks missing in last 24h (approx): ${missingTicks ?? 'n/a'}`);

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
