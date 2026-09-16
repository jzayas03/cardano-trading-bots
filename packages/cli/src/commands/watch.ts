import { statfsSync } from 'node:fs';
import { PgSnapshotRepo } from '@ctb/collector/pure';
import { createPool } from '@ctb/db';
import { checkBackupFreshness, checkDigestLines, checkDisk, checkPaperRuns, checkProcesses, checkQuotaSpend, checkRecurringTickErrors, checkTickProductivity, decideReport, evaluateMaintenance, verdict, type Check, type MaintenanceState, type PaperRunState } from '@ctb/reports';
import type { Logger } from 'pino';
import { UNPRODUCTIVE_TICKS_FAIL } from '@ctb/reports';
import { deleteMaintenanceFile, knownSecretsFrom, MAINTENANCE_PATH, readMaintenanceFile, report } from '../alerting.js';
import { DEFAULT_COLLECT_INTERVAL_SEC, effectiveTickIntervalSec, loadConfig } from '../config.js';
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

    const runs = await pool.query<{ id: number; strategy_id: string; ticker: string | null; status: string; heartbeat_at: Date | null }>(
      `SELECT r.id, r.strategy_id, t.ticker, r.status, r.heartbeat_at
         FROM runs r LEFT JOIN tokens t ON t.unit = r.base_unit
        WHERE r.mode = 'paper' AND r.status = 'running' ORDER BY r.id`,
    );
    const states: PaperRunState[] = runs.rows.map((r) => ({ id: r.id, strategyId: r.strategy_id, ticker: r.ticker, status: r.status, heartbeatAt: r.heartbeat_at }));
    checks.push(...checkPaperRuns(states, procs, new Date(), intervalSec));


    const now = new Date();
    const repo = new PgSnapshotRepo(pool);
    const digest = await repo.digestInput(effectiveTickIntervalSec(cfg), [...cfg.venues], now);
    checks.push(...checkDigestLines(digestLines(digest, now)));

    // The three checks that would have alarmed on 2026-09-08, when this watchdog ran fifteen times
    // and exited 0 through four hours of a dead feed. `lastRuns` already returns everything they
    // need, so this costs one query, not three.
    const ticks = await repo.lastRuns(UNPRODUCTIVE_TICKS_FAIL);
    checks.push(checkTickProductivity(ticks));
    checks.push(checkRecurringTickErrors(ticks));
    checks.push(checkQuotaSpend(digest.discoveryCallsToday + digest.refreshCallsToday, cfg.dailyCallCeiling));

    checks.push(checkBackupFreshness(newestBackupAgeHours()));

    const fs = statfsSync(process.cwd());
    checks.push(checkDisk(fs.bavail * fs.bsize, process.cwd()));
  } finally {
    await pool.end();
  }

  const v = verdict(checks);
  const bad = checks.filter((c) => c.status !== 'ok');
  // The dead-man's switch: one report per cycle, sent only once a verdict exists, in both branches
  // below. Its outcome is logged and never touches the exit code (FR-015) — a report that
  // could not be delivered is the service's problem to notice by silence, not this unit's failure.
  const reportCycle = (): Promise<void> => reportVerdict(log, cfg.healthcheckUrl, checks, v.line);
  if (bad.length === 0) {
    // Silence is the healthy signal. --verbose exists so a human can confirm the check is running
    // at all, which is the one thing silence cannot tell you.
    if (!quiet) console.log('watch: OK');
    process.exitCode = 0;
    await reportCycle();
    return;
  }
  for (const c of bad) console.log(`${c.status.toUpperCase()}: ${c.name} — ${c.detail}`);
  process.exitCode = v.exitCode === 0 ? 0 : 1;
  await reportCycle();
}

/**
 * Reads the maintenance window, retires it if it has expired (one `log` report says so), then
 * sends the cycle's own report: `fail` when any check FAILs outside a window, `alive` otherwise.
 * A WARN-only cycle is `alive` (f5acb93). Never throws; the log line carries kind, outcome, status
 * and host — never the URL, never the body.
 */
async function reportVerdict(log: Logger, healthcheckUrl: string | undefined, checks: Check[], verdictLine: string): Promise<void> {
  try {
    const now = new Date();
    let fileText: string | null = null;
    try {
      fileText = readMaintenanceFile(MAINTENANCE_PATH);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'maintenance file unreadable; treating as no window');
    }
    const maint = evaluateMaintenance(fileText, now);
    if (fileText !== null && maint === null) log.warn('maintenance file ignored: malformed or longer than the cap');
    let active: MaintenanceState | null = null;
    if (maint !== null && 'expired' in maint) {
      deleteMaintenanceFile(MAINTENANCE_PATH);
      const ended = await report(healthcheckUrl, 'log', `maintenance ended (expired): ${maint.reason}`);
      log.info({ kind: 'log', outcome: ended.outcome, status: ended.status, host: ended.host }, 'maintenance ended (expired)');
    } else {
      active = maint;
    }
    const { kind, body } = decideReport(checks, verdictLine, active, knownSecretsFrom(process.env));
    const r = await report(healthcheckUrl, kind, body);
    const line = { kind, outcome: r.outcome, status: r.status, host: r.host };
    // Without a URL every cycle would log "disabled": keep watch.log as quiet as it was.
    if (r.outcome === 'disabled') log.debug(line, 'healthcheck report');
    else log.info(line, 'healthcheck report');
  } catch (e) {
    log.error({ err: (e as Error).message }, 'healthcheck report failed');
  }
}
