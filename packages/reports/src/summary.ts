import type { EquityPoint, OrderRecord } from '@ctb/engine';
import { PRICE_UNIT, priceScaled } from './decimal.js';
import { tokenStr } from './format.js';

/**
 * Total equity restated in whole base tokens, carrying six decimals: `equity / (1e6 * price)`.
 *
 * The token's own `decimals` never appears, and does not need to — `price` is ADA per WHOLE token
 * and `equity` is lovelace, so the conversion is between two ADA-side quantities and the token's
 * subunit scale cancels. That is why this needs nothing the report does not already hold, and why
 * it works retroactively on every run already persisted.
 *
 * It restates TOTAL equity, not the position: a strategy sitting in cash has not lost its tokens,
 * it holds their value. "Tokens actually held" is `positionBase`, a different question.
 */
function baseTokensMicro(equityLovelace: bigint, priceScaledValue: bigint): bigint {
  return (equityLovelace * PRICE_UNIT) / priceScaledValue;
}

export interface DaySummary {
  points: number;
  startEquity: bigint | null; endEquity: bigint | null;
  startExecutable: bigint | null; endExecutable: bigint | null;
  returnPct: number | null;
  /** Total equity restated in whole base tokens (six decimals); null when the price is unreadable. */
  startBaseTokens: string | null; endBaseTokens: string | null;
  /**
   * The same window's return DENOMINATED IN THE BASE TOKEN — algebraically the ADA return deflated
   * by the price move, `(1 + returnPct) / (1 + priceChange) - 1`. It answers the question the ADA
   * column cannot: did this strategy end up with more TOKENS, or did the token simply go up?
   *
   * For an accumulation goal this is the number that matters, and buy-and-hold reads ~0 against it
   * by construction (it holds a constant token count, less fees) — which is the correct benchmark.
   * Measured on run 139 (the one funded buy-and-hold paper run): -3.10% in ADA, -1.04% in NIGHT.
   * The 2.06-point difference was the token getting cheaper, which an accumulator does not care
   * about; the -1.04% that remains is the entry cost, and it lands on the independently measured
   * 108 bps one-way floor.
   *
   * **The trap: a run that never traded is not neutral here.** Runs 137 and 138 sat in cash and read
   * +2.12% — not skill, just ADA buying 2.12% more NIGHT after the token fell. This restates TOTAL
   * equity in tokens, so idle cash tracks the inverse price move. Read it beside `filled`.
   *
   * Comparable only WITHIN one token: see `MIXED_TOKENS_WARNING`.
   */
  returnBasePct: number | null;
  filled: number;
  /** Split by side, because a completed ROUND TRIP closes on a sell: a strategy that only ever buys
   * has no round trips by design and is a baseline, not a candidate (see `promotion.ts`). */
  filledBuys: number; filledSells: number;
  rejected: number; rejectReasons: Record<string, number>; staleRejects: number;
  feesLovelace: bigint; poolFeesIn: bigint;
}

/**
 * Pure: the day's equity points and orders in, a summary out. `returnPct` is computed from the
 * first and last equity point of the day in basis points via bigint (never a float division on
 * lovelace amounts), and is null when there are fewer than two points or the start equity is 0 —
 * there is no return to report over zero or one point. `staleRejects` is the `stale t+1` sub-count
 * called out separately in the reject-reasons table (spec: a stale pair does not trade).
 */
export function summarizeDay(equity: EquityPoint[], orders: OrderRecord[]): DaySummary {
  const first = equity[0] ?? null;
  const last = equity.length > 0 ? equity[equity.length - 1]! : null;
  const startEquity = first ? first.equityLovelace : null;
  const endEquity = last ? last.equityLovelace : null;
  const returnPct =
    equity.length >= 2 && startEquity !== null && startEquity !== 0n && endEquity !== null
      ? Number(((endEquity - startEquity) * 10_000n) / startEquity) / 100
      : null;

  const startPrice = first ? priceScaled(first.price) : null;
  const endPrice = last ? priceScaled(last.price) : null;
  const startBaseTokens = first && startPrice !== null ? tokenStr(baseTokensMicro(first.equityLovelace, startPrice)) : null;
  const endBaseTokens = last && endPrice !== null ? tokenStr(baseTokensMicro(last.equityLovelace, endPrice)) : null;
  // endTokens / startTokens = (endAda * startPrice) / (startAda * endPrice) — the price SCALES
  // cancel, so this is exact in bigint and never materialises the token counts it compares.
  // `startEquity > 0n` where `returnPct` only asks `!== 0n`: this divides by it, and a negative
  // equity would silently flip the sign of the result rather than fail.
  const returnBasePct =
    equity.length >= 2 && startEquity !== null && startEquity > 0n && endEquity !== null && startPrice !== null && endPrice !== null
      ? Number(((endEquity * startPrice - startEquity * endPrice) * 10_000n) / (startEquity * endPrice)) / 100
      : null;

  let filled = 0;
  let filledBuys = 0;
  let filledSells = 0;
  let rejected = 0;
  let staleRejects = 0;
  let feesLovelace = 0n;
  let poolFeesIn = 0n;
  const rejectReasons: Record<string, number> = {};
  for (const o of orders) {
    if (o.result.status === 'filled') {
      filled++;
      if (o.intent.side === 'sell') filledSells++;
      else filledBuys++;
      feesLovelace += o.result.batcherFeeLovelace + o.result.networkFeeLovelace;
      poolFeesIn += o.result.poolFeeIn;
    } else {
      rejected++;
      rejectReasons[o.result.reason] = (rejectReasons[o.result.reason] ?? 0) + 1;
      if (o.result.reason.startsWith('stale t+1')) staleRejects++;
    }
  }
  return {
    points: equity.length,
    startEquity, endEquity,
    startExecutable: first ? first.equityExecutableLovelace : null,
    endExecutable: last ? last.equityExecutableLovelace : null,
    returnPct, startBaseTokens, endBaseTokens, returnBasePct,
    filled, filledBuys, filledSells, rejected, rejectReasons, staleRejects, feesLovelace, poolFeesIn,
  };
}

/**
 * The same pure computation as `summarizeDay`, named for its other use: the whole-run headline a
 * paper report prints from its PERSISTED rows. Final-review finding C1 — after a resume,
 * `runs.summary` describes only the segment whose process wrote it (`finishRun` overwrites the
 * column wholesale, and that process's `Summarizer` only ever saw its own candles). Verified on
 * rehearsal run 6: `summary` said 1 intent / 1 filled / 12 candles while `paper_orders` held 2 rows
 * and `run_equity` held 27. Equity points and orders in, one summary out — an alias rather than a
 * copy so the day view and the run headline can never drift apart.
 */
export const summarizeRun = summarizeDay;
