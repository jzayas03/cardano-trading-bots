import type { Check } from './doctor.js';

/**
 * The checks for the one-off cutover at the end of the seven-day run: stop the runs, rotate the
 * database password, deploy the backlog, turn multi-venue sampling on, then start the baseline.
 *
 * It exists as code rather than as runbook prose for a reason this project has already paid for.
 * `/root/post-reset.sh` aborted on first use over a psql boolean comparison and, being fail-closed,
 * **silently skipped the clean paper restart** — which then had to be done by hand. Prose gets
 * improvised under time pressure; a check that refuses does not.
 *
 * Every check reports whether it passed, not only whether it failed, so the sequence can be audited
 * rather than merely obeyed. **Every unknown is a FAIL**, never a pass: a check that could not run is
 * not a verdict, and on this day the cost of stopping to look is minutes while the cost of
 * proceeding on an unknown is the week's data.
 *
 * Nothing here performs an action. The rotation script (`infra/vps/rotate-postgres-password.sh`)
 * already exists and is not reimplemented; these are the gates between the steps.
 */

/** A nightly backup plus slack. Older than this and the run's data is not demonstrably recoverable. */
export const MAX_BACKUP_AGE_HOURS = 26;

export interface BeforeStopFacts {
  /** Age of the newest verified backup. Null when it could not be determined. */
  backupAgeHours: number | null;
  expectedRunIds: number[];
  runningRunIds: number[];
  /** Count of modified tracked files in the server checkout; null when git could not be read. */
  gitDirtyFiles: number | null;
  deployedSha: string;
  /** Null when the operator supplied no expectation. That is a check that did not run, not a pass:
   * comparing HEAD with itself reads OK while proving nothing. */
  expectedSha: string | null;
}

export interface AfterStopFacts {
  runningRunIds: number[];
  /** Expected runs that recorded no stop reason. */
  unfinishedRunIds: number[];
  collectorProcesses: number | null;
  newestHeartbeatAgeSec: number | null;
  intervalSec: number;
}

export interface AfterDeployFacts {
  deployedSha: string;
  expectedSha: string | null;
  migrationsApplied: number;
  migrationFiles: number;
  servicesActive: Record<string, boolean>;
  /** `COLLECT_MULTI_VENUE_EVERY_N_TICKS` as the collector reads it. Null when unset. */
  multiVenueEveryNTicks: number | null;
  /** Collector ticks recorded since the restart. Null when it could not be counted. */
  ticksSinceRestart: number | null;
}

const ok = (name: string, detail: string): Check => ({ name, status: 'ok', detail });
const fail = (name: string, detail: string): Check => ({ name, status: 'fail', detail });
const sameIds = (a: number[], b: number[]): boolean =>
  a.length === b.length && [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();

export function beforeStopChecks(f: BeforeStopFacts): Check[] {
  const checks: Check[] = [];

  checks.push(
    f.backupAgeHours === null
      ? fail('backup', 'backup age could not be determined — do not stop the runs until it can')
      : f.backupAgeHours > MAX_BACKUP_AGE_HOURS
        ? fail('backup', `newest backup is ${f.backupAgeHours.toFixed(1)}h old (max ${MAX_BACKUP_AGE_HOURS}h)`)
        : ok('backup', `newest backup ${f.backupAgeHours.toFixed(1)}h old`),
  );

  // Stopping the WRONG runs, or missing one, is unrecoverable in the sense that matters: the week
  // cannot be re-run. Exact set equality, not "at least the ones I expected".
  checks.push(
    sameIds(f.runningRunIds, f.expectedRunIds)
      ? ok('runs alive', `running: ${f.runningRunIds.join(', ')}`)
      : fail('runs alive', `expected ${f.expectedRunIds.join(', ')} running, found ${f.runningRunIds.join(', ') || 'none'}`),
  );

  checks.push(
    f.gitDirtyFiles === null
      ? fail('worktree clean', 'git status could not be read on the server checkout')
      : f.gitDirtyFiles > 0
        ? fail('worktree clean', `${f.gitDirtyFiles} modified tracked file(s) on the server — tracked files are never edited here, and a deploy will wipe them`)
        : ok('worktree clean', 'no modified tracked files'),
  );

  checks.push(shaCheck(f.deployedSha, f.expectedSha, ' — find out why before changing anything'));
  return checks;
}

/** Shared so the two phases cannot drift into disagreeing about what "the right commit" means. */
function shaCheck(deployed: string, expected: string | null, suffix = ''): Check {
  if (expected === null || expected === '') {
    return fail('deployed sha', `no expected sha given; pass --expect-sha. Comparing HEAD with itself would read OK while proving nothing${suffix}`);
  }
  return deployed === expected
    ? ok('deployed sha', deployed)
    : fail('deployed sha', `server is at ${deployed}, expected ${expected}${suffix}`);
}

export function afterStopChecks(f: AfterStopFacts): Check[] {
  const checks: Check[] = [];

  // THE load-bearing check. `paper-start.sh` RESUMES a row marked running, so one row left in that
  // state turns the clean restart into a silent continuation of the old run — and the ids look
  // right either way, which is what makes it dangerous rather than merely wrong.
  checks.push(
    f.runningRunIds.length === 0
      ? ok('no running rows', 'zero runs marked running')
      : fail('no running rows', `${f.runningRunIds.join(', ')} still marked running; paper-start would RESUME these instead of starting clean`),
  );

  checks.push(
    f.unfinishedRunIds.length === 0
      ? ok('runs finished', 'every expected run recorded a stop reason')
      : fail('runs finished', `no stop reason recorded for ${f.unfinishedRunIds.join(', ')}`),
  );

  checks.push(
    f.collectorProcesses === null
      ? fail('collector stopped', 'the process table could not be read — treat that as someone still being there')
      : f.collectorProcesses > 0
        ? fail('collector stopped', `${f.collectorProcesses} collector process(es) still alive`)
        : ok('collector stopped', 'no collector process'),
  );

  // Deliberately inverted: everywhere else a stale heartbeat is the alarm. Here a FRESH one means a
  // writer survived the stop. Same 2*interval + grace bound the resume path uses, so the two cannot
  // drift into disagreeing about what "nobody is there" means.
  const bound = 2 * f.intervalSec + 60;
  checks.push(
    f.newestHeartbeatAgeSec === null
      ? fail('heartbeats stale', 'no heartbeat age available — cannot show that nothing is writing')
      : f.newestHeartbeatAgeSec <= bound
        ? fail('heartbeats stale', `newest heartbeat is ${f.newestHeartbeatAgeSec}s old, inside the ${bound}s liveness bound — something is still writing`)
        : ok('heartbeats stale', `newest heartbeat ${f.newestHeartbeatAgeSec}s old, past the ${bound}s bound`),
  );
  return checks;
}

export function afterDeployChecks(f: AfterDeployFacts): Check[] {
  const checks: Check[] = [];

  checks.push(shaCheck(f.deployedSha, f.expectedSha));

  // Both directions fail. More applied than files means this checkout is BEHIND the database, which
  // is a different emergency from a pending migration and must not read as "fine, extra".
  const pending = f.migrationFiles - f.migrationsApplied;
  checks.push(
    pending === 0
      ? ok('migrations', `${f.migrationsApplied} applied, none pending`)
      : pending > 0
        ? fail('migrations', `${pending} pending — the collector must not start against old schema`)
        : fail('migrations', `${-pending} more applied than this checkout has files: the checkout is BEHIND the database`),
  );

  const services = Object.entries(f.servicesActive);
  const down = services.filter(([, active]) => !active).map(([n]) => n);
  checks.push(
    services.length === 0
      ? fail('services', 'no service state was collected — an empty list is not the same as all healthy')
      : down.length === 0
        ? ok('services', `${services.length} active: ${services.map(([n]) => n).join(', ')}`)
        : fail('services', `inactive: ${down.join(', ')}`),
  );

  checks.push(
    f.multiVenueEveryNTicks === null || f.multiVenueEveryNTicks <= 0
      ? fail('multi-venue', 'COLLECT_MULTI_VENUE_EVERY_N_TICKS is unset or zero; after the run is exactly when it should be on (#98)')
      : ok('multi-venue', `sampling every ${f.multiVenueEveryNTicks} ticks`),
  );

  // A unit that is `active` has been LAUNCHED. It has not necessarily done anything, and this
  // project has a documented history of green deploy jobs that deployed nothing.
  checks.push(
    f.ticksSinceRestart === null
      ? fail('collector ticking', 'tick count since restart could not be read')
      : f.ticksSinceRestart <= 0
        ? fail('collector ticking', 'no tick recorded since the restart — active is not the same as working')
        : ok('collector ticking', `${f.ticksSinceRestart} tick(s) since restart`),
  );
  return checks;
}
