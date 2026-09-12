/**
 * The morning one-screen: is the collector alive, is it keeping up, and will it run out of Blockfrost
 * quota before midnight UTC. Pure, so the arithmetic is unit-tested with fixed inputs; the SQL that
 * feeds it lives in `status.ts`.
 */

/** Blockfrost's free plan, requests per UTC day. The dashboard counter is the authority; this is the line the projection is read against. */
export const BLOCKFROST_FREE_DAILY_QUOTA = 50_000;
/** Below this projected daily figure the run is comfortably inside the quota; up to the quota it is WATCH; above it the operator stops the collector. */
export const QUOTA_OK_BELOW = 40_000;
/** Projections over less than this much of the day are noise (one discovery tick at 00:13 UTC projects to 600k/day). */
export const MIN_PROJECTION_ELAPSED_SEC = 30 * 60;

export interface DigestInput {
  /** The interval at which the collector writes a ROW — the focus interval when tiered sampling is on
   *  (`COLLECT_FOCUS_INTERVAL_SECONDS`), otherwise the candle interval. Named for what it measures:
   *  handing the candle interval to a row count is what made this very line print a clamped, false
   *  `(0 missing)` on 2026-09-12 while one tick genuinely was missed. See `cadence.ts`. */
  tickIntervalSec: number;
  lastFinished: { tickTs: Date; finishedAt: Date; poolsWritten: number; poolsFailed: number; providerCalls: number; discovered: boolean } | null;
  /** Distinct finished ticks in the trailing 24 h. */
  ticksLast24h: number;
  /** provider_calls over runs started at or after 00:00 UTC today, split by tick kind: discovery is a
   * fixed cost paid once (or twice on a restart), refresh recurs every boundary, so only the refresh
   * half is projected over the day. Read together they still equal the dashboard's count for today. */
  discoveryCallsToday: number;
  refreshCallsToday: number;
  /** Venues the collector is configured to poll; those with at least one snapshot at or after the newest discovery tick (a venue retried back in later counts); those in the newest tick of any kind. */
  venuesConfigured: string[];
  venuesSinceLastDiscovery: string[];
  venuesInLastTick: string[];
  /** Universe tokens, and how many of them have at least one pool in the newest snapshot tick. */
  tokensTotal: number;
  tokensCoveredInLastTick: number;
  /** tick_ts of the newest finished discovery run, if any. */
  lastDiscoveryAt: Date | null;
  poolFailures24h: number;
  venueErrors24h: number;
  /** Runs started in the trailing 24 h with no finished_at — the newest one may simply be in flight; older ones are killed processes. A row older than a day is history, not a live problem. */
  unfinishedRuns: number;
}

export function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)}m`;
const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)}h`;

export function digestLines(d: DigestInput, now: Date): string[] {
  const out: string[] = [];
  const expected24h = Math.floor(86_400 / d.tickIntervalSec);
  if (d.lastFinished) {
    const age = now.getTime() - d.lastFinished.finishedAt.getTime();
    const stale = age > 2 * d.tickIntervalSec * 1000;
    out.push(`collector: ${stale ? 'STALE — ' : ''}last tick ${d.lastFinished.tickTs.toISOString()} finished ${minutes(age)} ago | ${d.lastFinished.poolsWritten} pools written, ${d.lastFinished.poolsFailed} failed, ${d.lastFinished.providerCalls} calls${d.lastFinished.discovered ? ' (discovery)' : ''}`);
  } else {
    out.push('collector: no finished tick on record');
  }
  // Not clamped. `Math.max(…, 0)` used to turn a wrong interval into a confident `(0 missing)`, which
  // on an operator screen reads as "nothing missing" — strictly worse than an obviously broken
  // number, because nobody re-checks a zero. More ticks than slots means the interval is wrong, and
  // that is what the line should say.
  const missing = expected24h - d.ticksLast24h;
  out.push(`ticks last 24h: ${d.ticksLast24h} of ${expected24h} expected at ${d.tickIntervalSec}s (${missing >= 0 ? `${missing} missing` : `more ticks than slots — ${d.tickIntervalSec}s is not the cadence this collector runs at`})`);
  const elapsedMs = now.getTime() - utcMidnight(now).getTime();
  const elapsedSec = elapsedMs / 1000;
  const callsToday = d.discoveryCallsToday + d.refreshCallsToday;
  if (elapsedSec < MIN_PROJECTION_ELAPSED_SEC) {
    out.push(`calls since 00:00 UTC: ${callsToday} (${d.discoveryCallsToday} discovery + ${d.refreshCallsToday} refresh) over ${minutes(elapsedMs)} — too early to project a day (needs ${MIN_PROJECTION_ELAPSED_SEC / 60}m); check the Blockfrost dashboard`);
  } else {
    // Discovery already happened; only refresh recurs. Projecting the whole count would read a
    // 5,700-call discovery at 00:13 UTC as 155k/day at 01:17 (seen on the first real digest).
    const projected = d.discoveryCallsToday + Math.round((d.refreshCallsToday / elapsedSec) * 86_400);
    const pct = ((projected / BLOCKFROST_FREE_DAILY_QUOTA) * 100).toFixed(0);
    const verdict = projected > BLOCKFROST_FREE_DAILY_QUOTA ? 'STOP the collector (pkill -TERM -f \'main.ts collect\')' : projected > QUOTA_OK_BELOW ? 'WATCH' : 'OK';
    out.push(`calls since 00:00 UTC: ${callsToday} (${d.discoveryCallsToday} discovery + ${d.refreshCallsToday} refresh over ${hours(elapsedMs)}) -> projected ${projected}/day of ${BLOCKFROST_FREE_DAILY_QUOTA} (${pct}%) | quota: ${verdict}`);
  }
  // Two different absences, two different meanings. A venue with no snapshot since the last discovery
  // is LOST (Dexter returned nothing, counted as a venue failure); the collector retries it on every
  // tick until it returns. A venue found but missing from a refresh tick was PRUNED by
  // COLLECT_REFRESH=deepest — it is the deepest pool for no token — which is the policy working.
  const lost = d.venuesConfigured.filter((v) => !d.venuesSinceLastDiscovery.includes(v));
  const pruned = d.venuesSinceLastDiscovery.filter((v) => !d.venuesInLastTick.includes(v));
  out.push(lost.length
    ? `venues LOST since the last discovery: ${lost.join(', ')} (configured: ${d.venuesConfigured.join(', ')}) — retried every tick until they return; check the run rows' errors if it persists`
    : `venues found since the last discovery: all ${d.venuesConfigured.length} configured`);
  if (pruned.length) out.push(`venues found but not refreshed (deepest for no token): ${pruned.join(', ')}`);
  const uncovered = d.tokensTotal - d.tokensCoveredInLastTick;
  out.push(uncovered > 0
    ? `tokens with NO pool in the newest tick: ${uncovered} of ${d.tokensTotal} — those tokens have no candles until a discovery finds them a pool`
    : `tokens covered in the newest tick: ${d.tokensTotal} of ${d.tokensTotal}`);
  out.push(d.lastDiscoveryAt ? `last discovery: ${d.lastDiscoveryAt.toISOString()} (${hours(now.getTime() - d.lastDiscoveryAt.getTime())} ago)` : 'last discovery: never');
  out.push(`last 24h: ${d.poolFailures24h} pool failures, ${d.venueErrors24h} venue errors, ${d.unfinishedRuns} unfinished run${d.unfinishedRuns === 1 ? '' : 's'}${d.unfinishedRuns > 0 ? ' (the newest may be in flight)' : ''}`);
  return out;
}
