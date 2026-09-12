/**
 * How often the collector actually writes a row, and whether the number we print about missing ticks
 * rests on a true assumption.
 *
 * `collector_runs` gets one row per SAMPLING tick. When tiered sampling is on
 * (`COLLECT_FOCUS_TICKER` + `COLLECT_FOCUS_INTERVAL_SECONDS`) that is the FOCUS interval, not the
 * candle interval — the focus token is priced every focus tick and the rest of the universe every
 * candle boundary, but both write one row. Passing the candle interval where the sampling interval
 * belongs is what made `status` print `ticks missing in last 24h (approx): -191` on 2026-09-12
 * (287 rows observed against 86400/900 = 96 "expected"), and made the digest's clamped version print
 * a confident `(0 missing)` on the same day one tick genuinely WAS missed.
 *
 * Pure: no imports, no I/O. The SQL that measures the inputs lives in `@ctb/collector`'s repo.
 */

/** The interval at which a row is written — the focus interval when tiered sampling is on. */
export function effectiveTickIntervalSec(cfg: { intervalSec: number; focusIntervalSec: number }): number {
  return cfg.focusIntervalSec > 0 ? cfg.focusIntervalSec : cfg.intervalSec;
}

export interface TickCadence {
  /** Distinct `tick_ts` recorded in the trailing 24 h. */
  ticks: number;
  /** Rows expected in 24 h at `configuredIntervalSec`. */
  expected: number;
  /** The sampling interval the caller believes the collector runs at. */
  configuredIntervalSec: number;
  /**
   * The most common gap between consecutive distinct ticks — what the collector is OBSERVED to do,
   * independent of any config this process happens to read. `null` when fewer than two ticks exist,
   * because a cadence cannot be measured from one point.
   */
  observedIntervalSec: number | null;
}

/**
 * The cell both `status` and the dashboard's health page render, so neither can drift from the other.
 *
 * Every branch that cannot honestly produce a count says so instead of producing one. That is the
 * point of this function: the old code subtracted and printed whatever came out, so a wrong interval
 * surfaced as a negative in one caller and — clamped with `Math.max(…, 0)` — as a reassuring zero in
 * the other. A zero on an operator screen reads as "nothing missing", which is a strictly worse
 * failure than a number that is obviously nonsense.
 */
export function missingTicksCell(c: TickCadence | null): string {
  if (c === null) return 'n/a';
  if (c.observedIntervalSec === null) {
    // Nothing to cross-check against, and this is also how a dead collector presents: refusing to
    // print "0 missing" here is the whole reason the branch exists.
    return `n/a (${c.ticks} tick${c.ticks === 1 ? '' : 's'} in 24h — too few to measure a cadence)`;
  }
  if (c.observedIntervalSec !== c.configuredIntervalSec) {
    return `n/a (observed ${c.observedIntervalSec}s cadence, configured ${c.configuredIntervalSec}s — one of them is wrong)`;
  }
  if (c.ticks > c.expected) {
    return `n/a (${c.ticks} ticks exceeds the ${c.expected} expected at ${c.configuredIntervalSec}s)`;
  }
  return String(c.expected - c.ticks);
}
