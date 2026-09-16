import { evaluateMaintenance, MAX_MAINTENANCE_MINUTES, MAX_REASON_CHARS, type MaintenanceState } from '@ctb/reports';
import type { Logger } from 'pino';
import { deleteMaintenanceFile, MAINTENANCE_PATH, readMaintenanceFile, report as sendReport, writeMaintenanceFile } from '../alerting.js';
import { describeOutcome } from './alert.js';
import { loadConfig } from '../config.js';

/**
 * `maintenance start --minutes <1..240> --reason "<text>" | maintenance end | maintenance status`
 *
 * The one mechanism that can make a FAIL not page, so every edge is closed: an explicit length
 * (no default), a hard cap (MAX_MAINTENANCE_MINUTES), no silent extension (an active window must
 * be ended first), an announced end, and a file the watchdog expires on its own. What it never
 * does: suppress `alive`. If the box goes silent during maintenance the founder is still paged.
 *
 * The file lives in $HOME, not the checkout, so `cutover --phase before-stop`'s "worktree clean"
 * gate does not see it. Without CTB_HEALTHCHECK_URL the file is still written and deleted — the
 * unit failure handler reads it too — and the notices simply are not sent.
 */
const USAGE = 'usage: maintenance start --minutes <1..240> --reason "<text>" | maintenance end | maintenance status';

export interface MaintenanceDeps {
  report?: typeof sendReport;
  env?: NodeJS.ProcessEnv;
  /** The window file; tests point it at a temp dir. */
  path?: string;
  now?: () => Date;
}

function arg(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): void {
  console.error(USAGE);
  process.exitCode = 2;
}

function minutesLeft(until: string, now: Date): number {
  return Math.ceil((Date.parse(until) - now.getTime()) / 60_000);
}

export async function maintenanceCommand(log: Logger, args: readonly string[], deps: MaintenanceDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const report = deps.report ?? sendReport;
  const path = deps.path ?? MAINTENANCE_PATH;
  const now = (deps.now ?? (() => new Date()))();
  const [sub, ...rest] = args;

  if (sub !== 'start' && sub !== 'end' && sub !== 'status') return usage();

  const current = evaluateMaintenance(readMaintenanceFile(path), now);
  const active: MaintenanceState | null = current !== null && !('expired' in current) ? current : null;

  if (sub === 'status') {
    if (active) console.log(`active until ${active.until} (${minutesLeft(active.until, now)} min left): ${active.reason}`);
    else if (current !== null && 'expired' in current) console.log(`no maintenance window (the last one, "${current.reason}", has expired)`);
    else console.log('no maintenance window');
    process.exitCode = 0;
    return;
  }

  // Both start and end announce themselves; the URL is optional for both.
  const cfg = loadConfig(env, { blockfrost: false });
  const announce = async (body: string): Promise<void> => {
    const r = await report(cfg.healthcheckUrl, 'log', body);
    log.info({ kind: 'log', outcome: r.outcome, status: r.status, host: r.host }, 'healthcheck report');
    console.log(body);
    if (r.outcome !== 'accepted' && r.outcome !== 'disabled') console.error(`notice not delivered: ${describeOutcome(r)}`);
  };

  if (sub === 'end') {
    const text = readMaintenanceFile(path);
    if (text === null) {
      console.log('no maintenance window; nothing to end');
      process.exitCode = 0;
      return;
    }
    // The reason comes from the file even when the window has already expired: the notice should
    // still say which window this was.
    let reason = '(unreadable)';
    try {
      const parsed = JSON.parse(text) as { reason?: unknown };
      if (typeof parsed.reason === 'string') reason = parsed.reason;
    } catch {
      // intentional: a malformed file is still deleted; the reason is simply unknown
    }
    deleteMaintenanceFile(path);
    await announce(`maintenance ended (manual): ${reason}`);
    process.exitCode = 0;
    return;
  }

  // start
  const minutesRaw = arg(rest, '--minutes');
  const minutes = minutesRaw === undefined ? Number.NaN : Number(minutesRaw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MAINTENANCE_MINUTES) {
    console.error(`--minutes must be an integer from 1 to ${MAX_MAINTENANCE_MINUTES}`);
    return usage();
  }
  const reason = (arg(rest, '--reason') ?? '').trim();
  if (reason === '' || reason.length > MAX_REASON_CHARS) {
    console.error(`--reason is required, at most ${MAX_REASON_CHARS} characters`);
    return usage();
  }
  if (active) {
    console.error(`a maintenance window is already active until ${active.until} (${active.reason}); use \`maintenance end\` first`);
    process.exitCode = 1;
    return;
  }
  const state: MaintenanceState = {
    until: new Date(now.getTime() + minutes * 60_000).toISOString(),
    reason,
    declaredAt: now.toISOString(),
  };
  writeMaintenanceFile(path, state);
  await announce(`maintenance started until ${state.until} (${minutes} min): ${reason}`);
  process.exitCode = 0;
}
