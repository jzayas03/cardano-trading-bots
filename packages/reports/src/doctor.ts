/**
 * Preflight checks, each a pure function over injected inputs so the trap cases are unit-testable
 * without a machine: the duplicate collector and the stale 300 s .env value of 2026-09-07 would
 * both have been caught here before they cost anything.
 */
import { DEFAULT_COLLECT_INTERVAL_SEC } from './heartbeat.js';

export type Status = 'ok' | 'warn' | 'fail';
export interface Check { name: string; status: Status; detail: string }

export function checkNode(version: string, nvmrc: string): Check {
  const want = Number.parseInt(nvmrc.trim(), 10);
  const have = Number.parseInt(version.replace(/^v/, ''), 10);
  if (!Number.isFinite(want)) return { name: 'node', status: 'warn', detail: `.nvmrc unreadable (${JSON.stringify(nvmrc.trim())}); running ${version}` };
  return have >= want
    ? { name: 'node', status: 'ok', detail: `${version} (.nvmrc ${want})` }
    : { name: 'node', status: 'fail', detail: `${version} is below .nvmrc ${want}; run nvm use` };
}

/** Presence by length only: the value never reaches stdout, a log, or a report. */
export function checkEnv(env: NodeJS.ProcessEnv): Check[] {
  const out: Check[] = [];
  out.push(env.DATABASE_URL
    ? { name: 'DATABASE_URL', status: 'ok', detail: `set (host ${safeHost(env.DATABASE_URL)})` }
    : { name: 'DATABASE_URL', status: 'fail', detail: 'missing; every command needs it' });
  const key = env.BLOCKFROST_PROJECT_ID ?? '';
  out.push(key.length > 0
    ? { name: 'BLOCKFROST_PROJECT_ID', status: 'ok', detail: `present (${key.length} chars; value not shown)` }
    : { name: 'BLOCKFROST_PROJECT_ID', status: 'warn', detail: 'absent or blank; collect will refuse to start (status/report/backtest do not need it)' });
  const raw = env.COLLECT_INTERVAL_SECONDS;
  if (raw === undefined || raw === '') {
    out.push({ name: 'COLLECT_INTERVAL_SECONDS', status: 'ok', detail: `unset; default ${DEFAULT_COLLECT_INTERVAL_SEC} s applies` });
  } else if (Number(raw) === DEFAULT_COLLECT_INTERVAL_SEC) {
    out.push({ name: 'COLLECT_INTERVAL_SECONDS', status: 'ok', detail: `${raw} s (same as the default)` });
  } else {
    out.push({ name: 'COLLECT_INTERVAL_SECONDS', status: 'warn', detail: `.env sets ${raw} s, overriding the ${DEFAULT_COLLECT_INTERVAL_SEC} s default — a stale value here silently changes the quota arithmetic and every paper run's clock` });
  }
  return out;
}

function safeHost(url: string): string {
  try { return new URL(url).hostname || '?'; } catch { return '?'; }
}

export interface ProcessLine { pid: number; command: string }

/**
 * Two collectors double the Blockfrost spend and race the run rows; it happened on 2026-09-07 when
 * a start line ran twice 36 s apart. `self` is this process's own pid, never counted.
 */
export function checkProcesses(lines: ProcessLine[], self: number): Check[] {
  // One CLI process is TWO entries in ps: the `tsx` wrapper and the Node child it spawns with
  // `--require .../tsx/dist/preflight.cjs`. Count wrappers only, or one collector reads as two
  // (the first real run of this check did exactly that).
  const own = lines.filter((l) => l.pid !== self && !/tsx\/dist\/preflight/.test(l.command));
  const collectors = own.filter((l) => /main\.ts collect(\s|$)/.test(l.command));
  const papers = own.filter((l) => /main\.ts paper(\s|$)/.test(l.command));
  const fakes = own.filter((l) => /main\.ts dev:fake-collector(\s|$)/.test(l.command));
  const out: Check[] = [];
  if (collectors.length > 1) out.push({ name: 'collector processes', status: 'fail', detail: `${collectors.length} running (pids ${collectors.map((l) => l.pid).join(', ')}); stop all but one: pkill -TERM -f 'main.ts collect'` });
  else out.push({ name: 'collector processes', status: 'ok', detail: collectors.length === 1 ? `1 running (pid ${collectors[0]!.pid})` : 'none running' });
  out.push({ name: 'paper processes', status: 'ok', detail: papers.length ? `${papers.length} running (pids ${papers.map((l) => l.pid).join(', ')})` : 'none running' });
  if (fakes.length) out.push({ name: 'fake collector', status: 'warn', detail: `${fakes.length} dev:fake-collector running; it writes synthetic rows` });
  return out;
}

export function checkMigrations(onDisk: string[], applied: string[]): Check {
  const appliedSet = new Set(applied);
  const pending = onDisk.filter((f) => !appliedSet.has(f));
  const onDiskSet = new Set(onDisk);
  const orphans = applied.filter((f) => !onDiskSet.has(f));
  if (pending.length) return { name: 'migrations', status: 'fail', detail: `${pending.length} not applied: ${pending.join(', ')}; run npm run migrate` };
  if (orphans.length) return { name: 'migrations', status: 'warn', detail: `${orphans.length} applied but missing on disk: ${orphans.join(', ')} (database is ahead of this checkout)` };
  return { name: 'migrations', status: 'ok', detail: `${onDisk.length} applied, none pending` };
}

export function checkFakeRows(snapshots: number, candles: number): Check {
  return snapshots > 0 || candles > 0
    ? { name: 'rehearsal data', status: 'warn', detail: `${snapshots} Fake pool_snapshots, ${candles} Fake candles present; a non-rehearsal paper run for those tokens will refuse to start (see RUNBOOK-paper.md cleanup)` }
    : { name: 'rehearsal data', status: 'ok', detail: 'no Fake rows' };
}

export const LOW_DISK_BYTES = 5 * 1024 ** 3;

export function checkDisk(freeBytes: number, path: string): Check {
  const gb = (freeBytes / 1024 ** 3).toFixed(1);
  return freeBytes < LOW_DISK_BYTES
    ? { name: 'disk', status: 'warn', detail: `${gb} GB free on ${path}; below 5 GB Postgres and the logs can run out mid-run` }
    : { name: 'disk', status: 'ok', detail: `${gb} GB free on ${path}` };
}

/** The digest's own lines, reduced to a status: STALE or STOP is a fail, WATCH a warn. Never re-derives what the digest computes. */
export function checkDigestLines(lines: string[]): Check[] {
  const collector = lines.find((l) => l.startsWith('collector:')) ?? 'collector: (no digest line)';
  const quota = lines.find((l) => l.startsWith('calls since 00:00 UTC')) ?? 'calls since 00:00 UTC: (no digest line)';
  const venues = lines.find((l) => l.startsWith('venues LOST'));
  const out: Check[] = [
    { name: 'collector tick', status: /STALE|no finished tick/.test(collector) ? 'warn' : 'ok', detail: collector.replace(/^collector: /, '') },
    { name: 'quota pace', status: /quota: STOP/.test(quota) ? 'fail' : /quota: WATCH/.test(quota) ? 'warn' : 'ok', detail: quota.replace(/^calls since 00:00 UTC: /, '') },
  ];
  if (venues) out.push({ name: 'venues', status: 'warn', detail: venues });
  return out;
}

export function verdict(checks: Check[]): { exitCode: number; line: string } {
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  if (fails.length) return { exitCode: 1, line: `doctor: ${fails.length} FAIL (${fails.map((c) => c.name).join(', ')})${warns.length ? `, ${warns.length} warn` : ''}` };
  return { exitCode: 0, line: warns.length ? `doctor: OK with ${warns.length} warning${warns.length === 1 ? '' : 's'} (${warns.map((c) => c.name).join(', ')})` : 'doctor: OK' };
}
