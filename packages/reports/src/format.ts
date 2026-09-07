import type { RunCoverage, RunRow } from '@ctb/engine';

/**
 * Lovelace to ADA with six decimals, in bigint. `Number(BigInt(x)) / 1e6` loses precision above
 * 2^53 lovelace (~9.007 billion ADA) and, more to the point, prints an approximation of a number the
 * whole report exists to make exact (finding M10).
 */
export const adaStr = (lovelace: string | bigint): string => {
  const v = BigInt(lovelace);
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? '-' : ''}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, '0')}`;
};

/**
 * Coverage belongs in the header, next to the provenance: a return figure computed over 4400 sparse
 * candles in a window that should hold 26 000 is not the same claim as one computed over a full
 * window, and nothing else on the report says which one it is (finding C3).
 */
export function coverageLine(c: RunCoverage | undefined): string {
  if (!c) return 'coverage: not recorded (run predates coverage stats)';
  const pct = c.expectedBuckets > 0 ? ((c.candles / c.expectedBuckets) * 100).toFixed(1) : '0.0';
  const range = c.first && c.last ? `${c.first} -> ${c.last}` : 'empty window';
  return `coverage: ${c.candles} of ${c.expectedBuckets} expected buckets (${pct}%) | ${range} | max gap ${Math.round(c.maxGapMs / 60_000)}m | ${c.gapsOverBound} gaps over the stale-fill bound`;
}

/** The ISO timestamps `RunRepo.appendResume` has appended to `params.resumes`, or [] on a run that
 * predates the column or has never been resumed. Read as `unknown[]` and stringified per element —
 * this is a jsonb blob, not a typed column. */
export function resumesOf(run: Pick<RunRow, 'params'>): string[] {
  const raw = run.params.resumes;
  return Array.isArray(raw) ? raw.map((x) => String(x)) : [];
}

/**
 * Finding I4: the run's own view of its feed, from `params.feedCounters`. A day of `yielded 0` with
 * a climbing `empty` count is what a dead collector looks like from inside the paper process, and
 * before this it was visible only in a log file nobody kept. Read defensively — this is a jsonb blob
 * that a run predating the counters simply will not have, and "not recorded" must not read as zero.
 */
export function feedCountersLine(params: Record<string, unknown>): string {
  const raw = params.feedCounters;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'feed: not recorded (run predates feed counters)';
  const c = raw as Record<string, unknown>;
  const n = (k: string): string => (typeof c[k] === 'number' ? String(c[k]) : '?');
  return `feed: ${n('ticks')} ticks | ${n('built')} built | ${n('yielded')} yielded | ${n('skippedStale')} stale-skipped | ${n('emptyBoundaries')} empty | ${n('tickFailures')} failed`;
}

/**
 * M4b/M4c, `/universe` (fix round, IMPORTANT 2): the instant 24 hours before `now` — the screener's
 * price baseline `snapshotsAt` is asked for. Here rather than in `packages/dashboard/src`, because
 * the OTHER half of this same figure (`priceChangePct`, immediately below) already lives here, and a
 * figure split across that exact package boundary is what the dashboard's one rule (no computed
 * numbers of its own) exists to prevent — the dashboard owning "24 hours ago" while this package owns
 * "what percentage that change is" would be the same figure computed by two different rulebooks.
 * `86_400_000` (24h in milliseconds) is a numeric-literal computation, not a call to `now.getTime()`
 * dereferenced elsewhere, so nothing here needs a named constant to explain it — see `server.ts`'s own
 * call site for why this replaced a per-file allowlist entry rather than a constant next to it.
 */
export function dayAgo(now: Date): Date {
  return new Date(now.getTime() - 86_400_000);
}

/**
 * M4b/M4c, `/universe`: the screener's 24-hour change column. Lives here, not in
 * `packages/dashboard/src`, because that package's one rule is that it computes no numbers itself —
 * every figure it shows is the return value of a function imported from `@ctb/reports` (or
 * `@ctb/candles`/`@ctb/sim-executor` for a figure those packages own), and a percentage change is
 * exactly the kind of figure this rule exists to keep out of the dashboard's own code. `then`/`now`
 * are the same 18-place ADA-per-token decimal strings `@ctb/candles`'s `priceAdaPerToken` produces
 * — this file must never import `@ctb/candles` itself (the purity guard forbids it, since `@ctb/
 * candles` pulls in `pg`), so `Number()` on a decimal string is the boundary: the same
 * display-precision crossing `chart.ts` already makes for the equity chart, never a path back into
 * exact arithmetic.
 *
 * `null` — never `0` — for a `then` that is absent, unparseable, or exactly `0`: there is no
 * percentage of nothing, and printing `0` there would read as "unchanged" when the truth is "no
 * baseline to compare against" (the same distinction `resumesOf`/`feedCountersLine` above draw
 * between "not recorded" and an actual zero). Two EQUAL, non-zero prices are `0` — a real, known fact
 * ("unchanged"), not an absence.
 */
export function priceChangePct(then: string | null | undefined, now: string | null | undefined): number | null {
  if (then === null || then === undefined || now === null || now === undefined) return null;
  const a = Number(then);
  const b = Number(now);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return Math.round(((b - a) / a) * 10_000) / 100;
}
