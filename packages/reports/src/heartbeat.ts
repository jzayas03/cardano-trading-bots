/** The collector's default boundary; `status` and `paper` fall back to it for a run row that carries no interval of its own. */
export const DEFAULT_COLLECT_INTERVAL_SEC = 600;
export const DEFAULT_GRACE_SEC = 60;

/**
 * A running paper process only proves it is alive through its heartbeat. `2 * intervalSec +
 * graceSec` is a liveness bound for the paper process itself — it is unrelated to `maxGapMs` and to
 * `liveCandleFeed`'s late-tick rule (that rule skips one candle once its own age exceeds
 * `maxGapMs`, a data-freshness check on the feed; this one is a process-heartbeat check with a
 * different formula entirely). One missed heartbeat is normal jitter, two is a process an operator
 * should look at. A run that has never heartbeated is treated as STALE too, not as age 0. Pure and
 * exported so the STALE rule is unit-testable without a live process or a `Date.now` mock.
 */
export function heartbeatAgeCell(heartbeatAt: Date | null, params: Record<string, unknown>, now: Date): string {
  if (!heartbeatAt) return 'STALE';
  const ageS = Math.round((now.getTime() - heartbeatAt.getTime()) / 1000);
  // Finding M1: a bare `STALE` said a run had stopped ticking but not for how long, so an operator
  // could not tell a process that died 30 seconds past the bound from one that died two days ago —
  // and the second is the one where resuming replays a very different amount of missed history.
  return isHeartbeatStale(heartbeatAt, params, now) ? `STALE (${ageS}s)` : String(ageS);
}

/**
 * The STALE predicate itself, so `status`'s cell and `paper --resume`'s refusal decide liveness from
 * one bound instead of two that can drift apart (finding C2). A run that has never heartbeated is
 * stale: it proved nothing about being alive. Params default to the `paper` command's own defaults
 * for a row that predates them.
 */
export function isHeartbeatStale(heartbeatAt: Date | null, params: Record<string, unknown>, now: Date): boolean {
  if (!heartbeatAt) return true;
  const intervalSec = typeof params.intervalSec === 'number' ? params.intervalSec : DEFAULT_COLLECT_INTERVAL_SEC;
  const graceSec = typeof params.graceSec === 'number' ? params.graceSec : DEFAULT_GRACE_SEC;
  return now.getTime() - heartbeatAt.getTime() > (2 * intervalSec + graceSec) * 1000;
}
