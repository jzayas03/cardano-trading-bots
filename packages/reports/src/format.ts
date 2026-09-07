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
