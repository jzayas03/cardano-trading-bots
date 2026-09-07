import { execFileSync } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool, listMigrations } from '@ctb/db';
import type { Logger } from 'pino';
import { DEFAULT_COLLECT_INTERVAL_SEC, loadConfig } from '../config.js';
import { digestLines } from '../digest.js';
import { checkDigestLines, checkDisk, checkEnv, checkFakeRows, checkMigrations, checkNode, checkProcesses, verdict, type Check, type ProcessLine } from '../doctor.js';
import { loadDigestInput } from './status.js';

/** `ps` for every user process, parsed into pid + command. `ps` is the one thing here that is not injectable. */
export function listProcesses(): ProcessLine[] {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const sp = l.indexOf(' ');
    return { pid: Number(l.slice(0, sp)), command: l.slice(sp + 1).trim() };
  }).filter((p) => Number.isFinite(p.pid));
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
      checks.push(...checkDigestLines(digestLines(await loadDigestInput(db, cfg.intervalSec, [...cfg.venues], now), now)));
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
