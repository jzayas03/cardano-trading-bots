import { execFileSync } from 'node:child_process';
import { createPool } from '@ctb/db';
import {
  afterDeployChecks, afterStopChecks, beforeStopChecks, verdict,
  type AfterDeployFacts, type AfterStopFacts, type BeforeStopFacts, type Check,
} from '@ctb/reports';
import type { Logger } from 'pino';
import { newestBackupAgeHours } from '../backupAge.js';
import { loadConfig } from '../config.js';
import { listProcesses } from './doctor.js';

/**
 * `cutover --phase <before-stop|after-stop|after-deploy> [--expect-sha X] [--runs 146,147,148]`
 *
 * The gates between the steps of the end-of-run cutover. It performs NOTHING: it reads, it reports,
 * and it exits non-zero when the state is not what the next step needs. Every fact it cannot read
 * comes back null and the corresponding check FAILS — a check that could not run is not a verdict,
 * and on this day proceeding on an unknown costs the week's data.
 */
const UNITS = ['ctb-collector', 'ctb-backup.timer', 'ctb-watch.timer'];

function arg(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** null on any failure, so the caller fails closed rather than reading an error as a clean tree. */
function git(...a: string[]): string | null {
  try {
    return execFileSync('git', a, { encoding: 'utf8' }).trim();
  } catch {
    return null; // intentional: an unreadable git is an unknown, and callers fail closed on unknowns
  }
}

function systemctlActive(unit: string): boolean | null {
  try {
    return execFileSync('systemctl', ['is-active', unit], { encoding: 'utf8' }).trim() === 'active';
  } catch (e) {
    // `is-active` EXITS NON-ZERO for an inactive unit, so a throw is the normal inactive path and
    // must be read as `false` -- but only when it actually ran. A missing systemctl is an unknown.
    const status = (e as { status?: number }).status;
    return typeof status === 'number' ? false : null;
  }
}

function collectorProcessCount(): number | null {
  try {
    return listProcesses().filter((p) => /main\.ts collect\b/.test(p.command)).length;
  } catch {
    return null; // intentional: an unreadable process table means "someone might be there"
  }
}

export async function cutoverCommand(log: Logger, args: readonly string[]): Promise<void> {
  const phase = arg(args, '--phase') ?? '';
  if (!['before-stop', 'after-stop', 'after-deploy'].includes(phase)) {
    throw new Error('cutover needs --phase before-stop | after-stop | after-deploy');
  }
  const expectedRunIds = (arg(args, '--runs') ?? '146,147,148').split(',').map((s) => Number(s.trim()));
  // NOT defaulted to HEAD: comparing the checkout with itself reads OK while proving nothing.
  const expectedSha = arg(args, '--expect-sha') ?? null;
  const cfg = loadConfig(process.env, { blockfrost: false });
  const db = createPool(cfg.databaseUrl, (e) => log.error({ err: e.message }, 'cutover pool error'));

  try {
    const running = await db.query<{ id: number }>("SELECT id FROM runs WHERE status = 'running' ORDER BY id");
    const runningRunIds = running.rows.map((r) => r.id);
    const deployedSha = git('rev-parse', '--short', 'HEAD') ?? '(unreadable)';
    const expectShort = expectedSha === null ? null : expectedSha.slice(0, deployedSha.length);

    let checks: Check[];
    if (phase === 'before-stop') {
      const dirty = git('status', '--porcelain', '--untracked-files=no');
      const facts: BeforeStopFacts = {
        backupAgeHours: newestBackupAgeHours(),
        expectedRunIds,
        runningRunIds,
        gitDirtyFiles: dirty === null ? null : dirty.split('\n').filter(Boolean).length,
        deployedSha, expectedSha: expectShort,
      };
      checks = beforeStopChecks(facts);
    } else if (phase === 'after-stop') {
      const hb = await db.query<{ age: string | null }>(
        "SELECT EXTRACT(EPOCH FROM (now() - max(heartbeat_at)))::text AS age FROM runs WHERE id = ANY($1::int[])",
        [expectedRunIds],
      );
      const unfinished = await db.query<{ id: number }>(
        "SELECT id FROM runs WHERE id = ANY($1::int[]) AND stop_reason IS NULL ORDER BY id",
        [expectedRunIds],
      );
      const age = hb.rows[0]?.age;
      const facts: AfterStopFacts = {
        runningRunIds,
        unfinishedRunIds: unfinished.rows.map((r) => r.id),
        collectorProcesses: collectorProcessCount(),
        newestHeartbeatAgeSec: age === null || age === undefined ? null : Math.round(Number(age)),
        intervalSec: cfg.intervalSec,
      };
      checks = afterStopChecks(facts);
    } else {
      const applied = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM schema_migrations').catch(() => ({ rows: [{ n: '-1' }] }));
      const files = git('ls-files', 'packages/db/migrations');
      const ticks = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM collector_runs WHERE started_at > now() - interval '1 hour'",
      ).catch(() => ({ rows: [{ n: '-1' }] }));
      const services: Record<string, boolean> = {};
      for (const u of UNITS) {
        const a = systemctlActive(u);
        // An unknown unit state is omitted, which makes the list incomplete rather than falsely
        // healthy -- and an EMPTY list fails, so omitting everything cannot read as success.
        if (a !== null) services[u] = a;
      }
      const nTicks = Number(ticks.rows[0]?.n ?? '-1');
      const facts: AfterDeployFacts = {
        deployedSha, expectedSha: expectShort,
        migrationsApplied: Number(applied.rows[0]?.n ?? '-1'),
        migrationFiles: files === null ? -1 : files.split('\n').filter((f) => f.endsWith('.sql')).length,
        servicesActive: services,
        multiVenueEveryNTicks: process.env.COLLECT_MULTI_VENUE_EVERY_N_TICKS ? Number(process.env.COLLECT_MULTI_VENUE_EVERY_N_TICKS) : null,
        ticksSinceRestart: nTicks < 0 ? null : nTicks,
      };
      checks = afterDeployChecks(facts);
    }

    console.log(`\n=== cutover ${phase} | runs ${expectedRunIds.join(',')} | ${new Date().toISOString()}`);
    for (const c of checks) console.log(`  ${c.status.toUpperCase().padEnd(4)} ${c.name.padEnd(18)} ${c.detail}`);
    const v = verdict(checks);
    console.log(v.line.replace('doctor:', 'cutover:'));
    if (v.exitCode !== 0) console.log('  DO NOT PROCEED to the next step until every check reads OK.');
    process.exitCode = v.exitCode;
  } finally {
    await db.end();
  }
}
