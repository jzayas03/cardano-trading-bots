import { statfsSync } from 'node:fs';
import { PgSnapshotRepo } from '@ctb/collector/pure';
import { createPool } from '@ctb/db';
import { checkBackupFreshness, checkDigestLines, checkDisk, checkPaperRuns, checkProcesses, verdict, type Check, type PaperRunState } from '@ctb/reports';
import type { Logger } from 'pino';
import { DEFAULT_COLLECT_INTERVAL_SEC, loadConfig } from '../config.js';
import { digestLines } from '../digest.js';
import { listProcessesWithAge } from '../ps.js';
import { newestBackupAgeHours } from '../backupAge.js';

/**
 * `watch` is `doctor` inverted: it says nothing when everything is fine, and one line per problem
 * when it is not, with a non-zero exit code. That shape is what makes it usable from cron or a
 * launchd timer, where a table printed every five minutes is noise nobody reads.
 *
 * It adds one check `doctor` does not make — correlating each `running` paper run with a live
 * process — because the failure this project keeps producing is something stopping while nothing
 * says so, and a run row that says `running` with nothing running it is exactly that.
 */

export async function watchCommand(log: Logger, args: readonly string[]): Promise<void> {
  const quiet = !args.includes('--verbose');
  const cfg = loadConfig(process.env, { blockfrost: false });
  const intervalSec = cfg.intervalSec ?? DEFAULT_COLLECT_INTERVAL_SEC;
  const pool = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'watch pool error'));
  const checks: Check[] = [];
  try {
    const procs = listProcessesWithAge() ?? [];
    checks.push(...checkProcesses(procs.map((p) => ({ pid: p.pid, command: p.command })), process.pid));

    const runs = await pool.query<{ id: number; strategy_id: string; status: string; heartbeat_at: Date | null }>(
      `SELECT id, strategy_id, status, heartbeat_at FROM runs WHERE mode = 'paper' AND status = 'running' ORDER BY id`,
    );
    const states: PaperRunState[] = runs.rows.map((r) => ({ id: r.id, strategyId: r.strategy_id, status: r.status, heartbeatAt: r.heartbeat_at }));
    checks.push(...checkPaperRuns(states, procs, new Date(), intervalSec));


    const now = new Date();
    checks.push(...checkDigestLines(digestLines(await new PgSnapshotRepo(pool).digestInput(intervalSec, [...cfg.venues], now), now)));

    checks.push(checkBackupFreshness(newestBackupAgeHours()));

    const fs = statfsSync(process.cwd());
    checks.push(checkDisk(fs.bavail * fs.bsize, process.cwd()));
  } finally {
    await pool.end();
  }

  const v = verdict(checks);
  const bad = checks.filter((c) => c.status !== 'ok');
  if (bad.length === 0) {
    // Silence is the healthy signal. --verbose exists so a human can confirm the check is running
    // at all, which is the one thing silence cannot tell you.
    if (!quiet) console.log('watch: OK');
    process.exitCode = 0;
    return;
  }
  for (const c of bad) console.log(`${c.status.toUpperCase()}: ${c.name} — ${c.detail}`);
  process.exitCode = v.exitCode === 0 ? 0 : 1;
}
