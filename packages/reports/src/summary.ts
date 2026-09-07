import type { EquityPoint, OrderRecord } from '@ctb/engine';

export interface DaySummary {
  points: number;
  startEquity: bigint | null; endEquity: bigint | null;
  startExecutable: bigint | null; endExecutable: bigint | null;
  returnPct: number | null;
  filled: number; rejected: number; rejectReasons: Record<string, number>; staleRejects: number;
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

  let filled = 0;
  let rejected = 0;
  let staleRejects = 0;
  let feesLovelace = 0n;
  let poolFeesIn = 0n;
  const rejectReasons: Record<string, number> = {};
  for (const o of orders) {
    if (o.result.status === 'filled') {
      filled++;
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
    returnPct, filled, rejected, rejectReasons, staleRejects, feesLovelace, poolFeesIn,
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
