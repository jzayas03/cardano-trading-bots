/**
 * Preflight checks, each a pure function over injected inputs so the trap cases are unit-testable
 * without a machine: the duplicate collector and the stale 300 s .env value of 2026-09-07 would
 * both have been caught here before they cost anything.
 */
import { DEFAULT_COLLECT_INTERVAL_SEC } from './heartbeat.js';

import { BLOCKFROST_FREE_DAILY_QUOTA } from './digest.js';

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
  // Count the node child tsx spawns with `--require .../tsx/dist/preflight.cjs` — that IS the
  // running CLI, and there is exactly one per run under every supervisor we use.
  //
  // The previous rule counted the wrappers instead and was not portable. Under launchd the chain is
  // `npm run collect` -> tsx -> preflight, and `npm run collect` does not match "main.ts collect",
  // so excluding the preflight child left one. Under systemd it is `sh -c tsx …main.ts collect` ->
  // tsx -> preflight, which DOES match, so the same rule counted two and reported every healthy
  // unit as a duplicate. Found on the M5 host, 2026-09-08.
  const own = lines.filter((l) => l.pid !== self && /tsx\/dist\/preflight/.test(l.command));
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

/**
 * Consecutive finished ticks that wrote nothing before this is a failure rather than a warning.
 * Three: enough that a single transient venue outage does not alarm, few enough that a real stall is
 * caught within minutes rather than hours.
 */
export const UNPRODUCTIVE_TICKS_FAIL = 3;

/** Consecutive finished ticks sharing one error scope before that scope is a failure. */
export const RECURRING_ERROR_TICKS_FAIL = 3;

/** Fraction of the vendor's daily TIER at which spend becomes a warning — not of our own ceiling. */
export const QUOTA_SPEND_WARN_AT = 0.8;

/** The fields these checks read from a collector run. A structural subset of `RunRow` so
 *  `@ctb/reports` does not have to depend on `@ctb/collector` for a type. */
export interface TickHealthRow {
  finishedAt: Date | null;
  poolsWritten: number;
  errors: ReadonlyArray<{ scope: string; message: string }>;
}

/**
 * Is the collector PRODUCING, not merely running?
 *
 * On 2026-09-08 this watchdog ran fifteen times and exited 0 every time, while the collector
 * finished a tick punctually every fifteen minutes writing `pools 0/0, calls 0` — the Blockfrost
 * quota was exhausted and every tick failed closed at `/blocks/latest` with a 402. Nothing was
 * stale, so the `collector tick` check was satisfied; the quota PACE projection actually improved,
 * because a tick that spends nothing lowers the projected rate. Ticking on time while collecting
 * nothing read as perfect health for four hours, with three paper runs sitting on the dead feed.
 *
 * Only finished ticks count: a tick still in flight has written nothing YET, which is not the same
 * as having written nothing.
 */
export function checkTickProductivity(runs: readonly TickHealthRow[], failAfter = UNPRODUCTIVE_TICKS_FAIL): Check {
  const finished = runs.filter((r) => r.finishedAt !== null);
  if (finished.length === 0) return { name: 'tick productivity', status: 'warn', detail: 'no finished tick to judge' };
  let barren = 0;
  for (const r of finished) {
    if (r.poolsWritten > 0) break;
    barren++;
  }
  if (barren >= failAfter) {
    return { name: 'tick productivity', status: 'fail', detail: `${barren} consecutive finished ticks wrote 0 pools — the collector is running but collecting nothing` };
  }
  if (barren > 0) {
    return { name: 'tick productivity', status: 'warn', detail: `${barren} of the last ${finished.length} finished ticks wrote 0 pools` };
  }
  return { name: 'tick productivity', status: 'ok', detail: `newest finished tick wrote ${finished[0]!.poolsWritten} pools` };
}

/**
 * One error repeating on every recent tick is a condition, not a blip.
 *
 * The 402 that stopped collection on 2026-09-08 was recorded on the run row of every single tick for
 * four hours and nothing ever read it. A recurring scope names the fault precisely — `tip`, `budget`,
 * `discover:MinswapV2` — which is the difference between "the collector is unhappy" and a fix.
 */
export function checkRecurringTickErrors(runs: readonly TickHealthRow[], failAfter = RECURRING_ERROR_TICKS_FAIL): Check {
  const finished = runs.filter((r) => r.finishedAt !== null).slice(0, failAfter);
  if (finished.length < failAfter) {
    return { name: 'tick errors', status: 'ok', detail: `fewer than ${failAfter} finished ticks to compare` };
  }
  // A scope must appear in EVERY one of the last `failAfter` ticks. An error on two of three is
  // intermittent, and alarming on it would train the operator to ignore this check.
  const scopeSets = finished.map((r) => new Set(r.errors.map((e) => e.scope)));
  const persistent = [...(scopeSets[0] ?? [])].filter((scope) => scopeSets.every((s) => s.has(scope))).sort();
  if (persistent.length === 0) {
    return { name: 'tick errors', status: 'ok', detail: `no error on all ${failAfter} newest finished ticks` };
  }
  const example = finished[0]!.errors.find((e) => e.scope === persistent[0])?.message ?? '';
  return {
    name: 'tick errors',
    status: 'fail',
    detail: `${persistent.join(', ')} on each of the last ${failAfter} ticks — ${example}`,
  };
}

/**
 * How much of the day's call ceiling is actually SPENT, as opposed to projected.
 *
 * `checkDigestLines`'s quota check extrapolates a rate, which answers "will today's pace fit" and
 * cannot answer "is there anything left right now". Those diverge exactly when it matters: once the
 * quota is gone every tick spends 0, the projected rate falls, and the pace check reports a
 * healthier number the longer the outage lasts.
 *
 * A ceiling of 0 means the operator disabled it (`COLLECT_DAILY_CALL_CEILING=0`); reporting a
 * percentage of zero would be a division by it.
 */
export function checkQuotaSpend(callsToday: number, ceiling: number, warnAt = QUOTA_SPEND_WARN_AT, tier = BLOCKFROST_FREE_DAILY_QUOTA): Check {
  if (ceiling <= 0) return { name: 'quota spend', status: 'ok', detail: `${callsToday} calls today; no ceiling configured` };
  const pctOfCeiling = (callsToday / ceiling) * 100;
  const pctOfTier = (callsToday / tier) * 100;
  // Both numbers, always: the ceiling is a brake WE set below the vendor's wall, and the two answer
  // different questions. Reaching our own brake means the next sweep is refused; approaching the
  // vendor's wall means the day is genuinely at risk.
  const detail = `${callsToday} calls: ${pctOfCeiling.toFixed(0)}% of the ${ceiling} ceiling, ${pctOfTier.toFixed(0)}% of the ${tier} tier`;
  if (callsToday >= ceiling) {
    return { name: 'quota spend', status: 'fail', detail: `${detail} — a discovery sweep will now be refused` };
  }
  // Warn on the TIER, not the ceiling. Warning at 80% of a self-imposed brake made a normal day
  // (~39,240 calls = 87% of a 45,000 ceiling, but only 78% of the 50,000 tier) warn EVERY DAY, and a
  // check that fires daily is one nobody reads.
  if (pctOfTier >= warnAt * 100) return { name: 'quota spend', status: 'warn', detail };
  return { name: 'quota spend', status: 'ok', detail };
}
