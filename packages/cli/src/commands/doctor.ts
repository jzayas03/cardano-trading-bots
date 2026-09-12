import { execFileSync } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PgSnapshotRepo } from '@ctb/collector/pure';
import { createPool, listMigrations } from '@ctb/db';
import type { Logger } from 'pino';
import { DEFAULT_COLLECT_INTERVAL_SEC, effectiveTickIntervalSec, loadConfig } from '../config.js';
import { digestLines } from '../digest.js';
import { checkDigestLines, checkDisk, checkEnv, checkFakeRows, checkMigrations, checkNode, checkProcesses, verdict, type Check, type ProcessLine } from '../doctor.js';

/** `ps` for every user process, parsed into pid + command. `ps` is the one thing here that is not injectable. */
export function listProcesses(): ProcessLine[] {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const sp = l.indexOf(' ');
    return { pid: Number(l.slice(0, sp)), command: l.slice(sp + 1).trim() };
  }).filter((p) => Number.isFinite(p.pid));
}

/** `npm run dashboard`'s own default (`commands/dashboard.ts`'s `DEFAULT_PORT`); doctor checks only
 * this well-known port, not whatever an operator may have passed as `--port`. */
export const DASHBOARD_HEALTH_URL = 'http://127.0.0.1:3210/';
const DASHBOARD_PROBE_TIMEOUT_MS = 1000;

/**
 * Pure: turns "did something answer" into a `Check`. A dashboard that is not running is not a
 * problem with the machine doctor is diagnosing — it is simply not running right now, same as
 * `paper processes` reads "none running" as `ok` — so this is `ok` either way; only the detail says
 * which. Kept separate from `probeDashboard` below so the mapping itself is testable with no network
 * call at all.
 */
export function dashboardCheck(reachable: boolean): Check {
  return { name: 'dashboard', status: 'ok', detail: reachable ? 'running' : 'not running' };
}

/**
 * The impure probe: a GET against the dashboard's well-known default port with a ~1s timeout.
 * `fetchImpl` is injectable (default: the global `fetch`) so callers can exercise every outcome —
 * refused connection, timeout, or an unexpected response — without a real network call, per the
 * brief's "if the fetch cannot be tested without a network call, inject it so it can be." Any
 * response at all, even a non-2xx one, means *something* is answering on that port and counts as
 * running; a refused connection, an aborted/timed-out request, or any other fetch failure all mean
 * "not running." This must never throw: a down dashboard is informational only, never a doctor FAIL.
 */
export async function probeDashboard(
  fetchImpl: typeof fetch = fetch,
  url: string = DASHBOARD_HEALTH_URL,
  timeoutMs: number = DASHBOARD_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(url, { signal: controller.signal });
    return true;
  } catch {
    // intentional: a refused connection (ECONNREFUSED), an aborted/timed-out request, or any other
    // fetch failure are all indistinguishable from "nothing is listening" for this check's purpose.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Preflight for the machine, before any long run. Every check that can be pure is pure (doctor.ts)
 * and unit-tested; this file only gathers the inputs. Exit code 1 on any FAIL so a start script can
 * gate on it. Prints nothing secret: the key is reported by length only.
 */
export async function doctorCommand(log: Logger): Promise<void> {
  const root = resolve(process.cwd());
  const checks: Check[] = [];
  let nvmrc = '';
  try { nvmrc = readFileSync(resolve(root, '.nvmrc'), 'utf8'); } catch { nvmrc = ''; }
  checks.push(checkNode(process.version, nvmrc));
  checks.push(...checkEnv(process.env));
  checks.push(...checkProcesses(listProcesses(), process.pid));
  checks.push(dashboardCheck(await probeDashboard()));
  try {
    checks.push(checkDisk(Number(statfsSync(root).bavail) * Number(statfsSync(root).bsize), root));
  } catch (err) {
    checks.push({ name: 'disk', status: 'warn', detail: `could not read free space: ${(err as Error).message}` });
  }
  if (!process.env.DATABASE_URL) {
    checks.push({ name: 'database', status: 'fail', detail: 'skipped: DATABASE_URL missing' });
  } else {
    const cfg = loadConfig(process.env, { blockfrost: false });
    const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
    try {
      await db.query('SELECT 1');
      checks.push({ name: 'database', status: 'ok', detail: 'reachable' });
      const applied = await db.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename").catch(() => ({ rows: [] as Array<{ filename: string }> }));
      checks.push(checkMigrations(await listMigrations(), applied.rows.map((r) => r.filename)));
      const fake = await db.query<{ s: string; c: string }>(
        "SELECT (SELECT count(*) FROM pool_snapshots WHERE dex = 'Fake') AS s, (SELECT count(*) FROM candles WHERE pool_id LIKE 'Fake:%') AS c",
      ).catch(() => ({ rows: [{ s: '0', c: '0' }] }));
      checks.push(checkFakeRows(Number(fake.rows[0]?.s ?? 0), Number(fake.rows[0]?.c ?? 0)));
      const now = new Date();
      checks.push(...checkDigestLines(digestLines(await new PgSnapshotRepo(db).digestInput(effectiveTickIntervalSec(cfg), [...cfg.venues], now), now)));
      if (cfg.intervalSec !== DEFAULT_COLLECT_INTERVAL_SEC) log.info({ intervalSec: cfg.intervalSec }, 'non-default collector interval in force');
    } catch (err) {
      checks.push({ name: 'database', status: 'fail', detail: `unreachable: ${(err as Error).message}` });
    } finally {
      await db.end();
    }
  }
  console.table(checks.map((c) => ({ check: c.name, status: c.status.toUpperCase(), detail: c.detail })));
  const v = verdict(checks);
  console.log(v.line);
  process.exitCode = v.exitCode;
}
