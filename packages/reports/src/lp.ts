import { priceScaled, ratioOf } from './decimal.js';

/**
 * What an LP position in ONE pool would have been worth, for every possible entry tick in the
 * observed window — the founder's question of 2026-09-09, "does knowing the entry price minimise
 * impermanent loss", turned into a measurement instead of an argument.
 *
 * The mechanics it encodes, because they are the part that gets misremembered:
 *
 * - **IL depends only on the RATIO of exit price to entry price, and only on the endpoints.** A
 *   round trip through any path costs nothing at the exit. There is therefore no entry price that is
 *   intrinsically good — only one that turns out to be near the exit. Entry timing helps exactly
 *   insofar as you enter near the centre of a range you have not seen yet.
 * - **The textbook IL number is measured in the wrong denominator for an accumulation goal.** A 50%
 *   rise costs 2.0% against the 50/50 basket and 18.4% of the token count. `vsHoldTokensPct` is the
 *   one to read if the goal is to stack the token; `ilPct` is here to show how much smaller the
 *   famous number is.
 * - **Fees are the entire edge, and this package cannot measure them.** See `feeLowerBoundPct`.
 *
 * Single-pool BY CONSTRUCTION, and not as a simplification: liquidity is provided to one pool, so a
 * series spliced across venues (which the collector's deepest-per-tick policy produces — see
 * `docs/ops/2026-09-07-first-real-candles.md`) would price a venue change as a market move.
 */
export interface LpCandle {
  tickTs: Date;
  /** Decimal, ADA per WHOLE token. */
  close: string;
  feeBps: number;
  tvlLovelace: bigint;
  /** Net reserve change on the quote side since the previous tick. NOT volume — see `feeLowerBoundPct`. */
  netFlowQuote: bigint | null;
}

export interface LpEntryRow {
  entryTs: Date;
  entryPrice: string;
  exitPrice: string;
  /** exit / entry, six places. */
  priceRatio: number;
  /** The textbook figure: LP against the 50/50 basket it started from. Symmetric in log price. */
  ilPct: number;
  /**
   * LP total value RESTATED IN TOKENS against simply holding the token — the accumulation metric,
   * and `sqrt(entry/exit) - 1`. Numerically identical to the LP's own token count against its start,
   * because both are that same square root: an LP position loses ground to holding at exactly the
   * rate its token count shrinks.
   */
  vsHoldTokensPct: number;
  /**
   * Fee income, as a percentage of position value, needed for the LP to match having held the token.
   * Negative means the LP is ahead before any fees at all (the price fell).
   *
   * It is `sqrt(exit/entry) - 1`, which is also exactly the LP's gain in ADA terms over never
   * entering. That identity is not a coincidence worth a second column: the fees you need to justify
   * providing liquidity are the same size as the ADA you made by doing it.
   */
  breakEvenFeePct: number;
  /**
   * A STRICT LOWER BOUND on fees earned, and usually a weak one. The collector records
   * `net_flow_quote` — the reserve delta between two ticks — and there is no volume column: a buy
   * and a sell of equal size inside one tick net to ZERO flow while paying two fees. Real fee income
   * is higher by an unknown factor, so this may not be compared with `breakEvenFeePct` to conclude
   * an LP position loses. It can only ever prove the position earns AT LEAST this much.
   */
  feeLowerBoundPct: number;
  /** Candles in this row's accrual window whose `feeBps` is 0 against a real pool — they contribute
   * nothing to the bound above, which is right but invisible unless it is counted. */
  feeBpsAnomalies: number;
}

export interface LpEntrySummary {
  entries: number;
  exitTs: Date;
  exitPrice: string;
  best: LpEntryRow;
  worst: LpEntryRow;
  median: LpEntryRow;
  /** best - worst in `vsHoldTokensPct`: what entry timing was worth across this whole window. */
  spreadPct: number;
  feeBpsAnomalies: number;
}

/** A fraction (0.0572) to a percentage with two places (5.72). */
const asPct = (fraction: number): number => Math.round(fraction * 10_000) / 100;

/** Fee earned over one tick as a fraction of the pool, from net flow. Bigint until the last step. */
function tickFeeFraction(c: LpCandle): number {
  if (c.netFlowQuote === null || c.feeBps <= 0 || c.tvlLovelace <= 0n) return 0;
  const flow = c.netFlowQuote < 0n ? -c.netFlowQuote : c.netFlowQuote;
  return Number((flow * BigInt(c.feeBps) * 1_000_000_000n) / (10_000n * c.tvlLovelace)) / 1e9;
}

/**
 * One row per candle that could have been an entry, each measured against the LAST candle. Candles
 * whose price cannot be read are skipped rather than given an invented ratio; an unreadable EXIT
 * price makes the whole sweep unmeasurable and returns [].
 */
export function lpEntryRows(candles: readonly LpCandle[]): LpEntryRow[] {
  if (candles.length < 2) return [];
  const exit = candles[candles.length - 1]!;
  const exitScaled = priceScaled(exit.close);
  if (exitScaled === null) return [];

  const rows: LpEntryRow[] = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const entry = candles[i]!;
    const entryScaled = priceScaled(entry.close);
    if (entryScaled === null) continue;

    const r = ratioOf(entryScaled, exitScaled);
    const root = Math.sqrt(r);

    let feeFraction = 0;
    let feeBpsAnomalies = 0;
    for (let j = i + 1; j < candles.length; j++) {
      const c = candles[j]!;
      feeFraction += tickFeeFraction(c);
      if (c.feeBps <= 0) feeBpsAnomalies++;
    }

    rows.push({
      entryTs: entry.tickTs,
      entryPrice: entry.close,
      exitPrice: exit.close,
      priceRatio: Math.round(r * 1e6) / 1e6,
      ilPct: asPct((2 * root) / (1 + r) - 1),
      vsHoldTokensPct: asPct(1 / root - 1),
      breakEvenFeePct: asPct(root - 1),
      feeLowerBoundPct: feeFraction * 100,
      feeBpsAnomalies,
    });
  }
  return rows;
}

/** Best, worst and median entry by `vsHoldTokensPct`, and the spread between the extremes. Null on
 * an empty sweep — an empty summary would render as a row of zeros and read as a measurement. */
export function lpEntrySummary(rows: readonly LpEntryRow[]): LpEntrySummary | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.vsHoldTokensPct - b.vsHoldTokensPct);
  const best = sorted[sorted.length - 1]!;
  const worst = sorted[0]!;
  return {
    entries: rows.length,
    exitTs: rows[rows.length - 1]!.entryTs,
    exitPrice: rows[0]!.exitPrice,
    best,
    worst,
    median: sorted[Math.floor((sorted.length - 1) / 2)]!,
    spreadPct: Math.round((best.vsHoldTokensPct - worst.vsHoldTokensPct) * 100) / 100,
    feeBpsAnomalies: rows.reduce((m, r) => Math.max(m, r.feeBpsAnomalies), 0),
  };
}
