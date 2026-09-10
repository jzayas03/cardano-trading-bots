import type { EquityPoint, OrderRecord, RunRow, RunSummaryStats } from '@ctb/engine';
import { adaStr } from './format.js';
import { promotionVerdict, type PromotionStatus, type RunContext } from './promotion.js';
import { summarizeRun } from './summary.js';
import { heartbeatAgeCell } from './heartbeat.js';

/**
 * The exact wording `report --compare`'s `printCompare` (packages/cli/src/commands/report.ts) and
 * the dashboard's `/compare` page (packages/dashboard/src/pages/compare.ts) both show when the
 * compared runs are not all on the same token. It used to be duplicated verbatim in both places — a
 * warning rather than a figure, so a drift there is cosmetic, but this file is already the shared
 * home for `compareRunRows`, and one string beats two that can quietly stop matching.
 */
export const MIXED_TOKENS_WARNING = 'warning: these runs are on different tokens; their returns are not comparable to each other';

/**
 * The exact wording `report --compare`'s `printCompare` and the dashboard's `/compare` page both show
 * when ANY compared run is a rehearsal. Deliberately different from the single-run `REHEARSAL —
 * synthetic data — not evidence` banner (`packages/dashboard/src/html.ts`'s `REHEARSAL_BANNER`, and
 * `printReport`'s own identical line): on a comparison page, "synthetic data — not evidence" reads as
 * "the whole page is synthetic," which is wrong on a mixed comparison of one rehearsal run and one real
 * one — only SOME of the rows are. This wording says exactly that (final review, MINOR finding: the
 * dashboard used to show the single-run wording here too, misleadingly).
 */
export const COMPARE_REHEARSAL_BANNER = 'REHEARSAL — one or more rows are synthetic data — not evidence';

export interface CompareInput { strategyId: string; runId: number; summary: RunSummaryStats }
export interface CompareRow {
  strategy: string; runId: number; candles: number; intents: number; filled: number; rejected: number;
  returnPct: number; maxDrawdownPct: number; feesAda: string; warnings: number;
}

/**
 * One row per strategy, in the order the operator listed them — never sorted by return, so the
 * table cannot read as a ranking. Every number is the run's own persisted summary; nothing here is
 * recomputed and the ADA formatting is the report's own `adaStr` (exact, six places — finding M10),
 * so the row and `report <run-id>` can never disagree.
 */
export function compareRows(results: CompareInput[]): CompareRow[] {
  return results.map(({ strategyId, runId, summary: s }) => ({
    strategy: strategyId, runId, candles: s.candles, intents: s.intents, filled: s.filled, rejected: s.rejected,
    returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct, feesAda: adaStr(s.feesLovelace), warnings: (s.warnings ?? []).length,
  }));
}

export interface CompareRunInput { run: RunRow; ticker: string; equity: EquityPoint[]; orders: OrderRecord[] }
export interface CompareRunRow {
  run: number; mode: string; strategy: string; ticker: string; status: string;
  /** Heartbeat age for a RUNNING paper run (STALE (Ns) past the bound); '-' for a finished/aborted run or a backtest. */
  heartbeat: string;
  /** Where the numbers come from: `rows` = every persisted equity point and order (paper runs); `summary` = `runs.summary` (backtests persist orders but no equity). */
  basis: 'rows' | 'summary';
  points: number; startAda: string; endAda: string; endExecAda: string; returnPct: number | string;
  /** The same run restated in its BASE TOKEN: did it end with more tokens, or did the token rise?
   * Comparable only within one token — see `MIXED_TOKENS_WARNING`, which applies harder here than it
   * does to the ADA columns. '-' on a backtest, whose row has no equity points to restate. */
  endTokens: string; returnTokenPct: number | string;
  /** Whether this run clears the promotion gate. The baselines are the OTHER runs in this same
   * comparison, which is why the gate lives here: a comparison is the moment the question is asked,
   * and it is the only place both baselines are already loaded over an identical window. */
  promotion: PromotionStatus;
  /** The first reason it is not a candidate, or '' when it is. Full list via `promotionVerdict`. */
  blocker: string;
  filled: number; rejected: number; staleRejects: number; feesAda: string; resumes: number; rehearsal: string;
}

/**
 * One row per run, in the order given, for `report --compare`. A paper run's numbers are the same
 * persisted-rows headline `printReport` prints for it (finding C1: never the last segment's
 * `runs.summary`), so this table and `report <id>` cannot disagree. A backtest persists orders but no
 * equity points, so its row reads `runs.summary` and says so in `basis`.
 */
export function compareRunRows(inputs: CompareRunInput[], now: Date): CompareRunRow[] {
  // Summarise every run once, up front: each row's promotion verdict needs the OTHER rows as its
  // baselines, and recomputing them per row would be both quadratic and a chance for two rows to
  // disagree about the same run's number.
  const summaries = new Map<number, ReturnType<typeof summarizeRun>>();
  const contexts = new Map<number, RunContext | undefined>();
  for (const { run, equity, orders } of inputs) {
    summaries.set(run.id, summarizeRun(equity, orders));
    const first = equity[0];
    const last = equity.length > 0 ? equity[equity.length - 1] : undefined;
    // Undefined when a run has no equity points (a backtest): the gate then bars it as not
    // comparable, which is correct — there is nothing to compare its conditions against.
    contexts.set(run.id, first && last
      ? { baseUnit: run.baseUnit, windowFromMs: first.tickTs.getTime(), windowToMs: last.tickTs.getTime(), startEquityLovelace: first.equityLovelace }
      : undefined);
  }

  return inputs.map(({ run, ticker, equity, orders }) => {
    const verdict = promotionVerdict({
      strategyId: run.strategyId,
      context: contexts.get(run.id),
      filledSells: summaries.get(run.id)!.filledSells,
      returnBasePct: summaries.get(run.id)!.returnBasePct,
      coverage: run.summary?.coverage,
      baselines: inputs
        .filter((o) => o.run.id !== run.id)
        .map((o) => ({ strategyId: o.run.strategyId, returnBasePct: summaries.get(o.run.id)!.returnBasePct, context: contexts.get(o.run.id) })),
    });
    const resumes = Array.isArray(run.params.resumes) ? run.params.resumes.length : 0;
    const common = {
      run: run.id, mode: run.mode, strategy: run.strategyId, ticker, status: run.status,
      // Liveness only means something for a run that claims to be alive; a finished or aborted run's last heartbeat is history.
      heartbeat: run.mode === 'paper' && run.status === 'running' ? heartbeatAgeCell(run.heartbeatAt, run.params, now) : '-',
      resumes, rehearsal: run.rehearsal ? 'REHEARSAL' : '',
      promotion: verdict.status, blocker: verdict.blockers[0] ?? '',
    };
    if (run.mode === 'paper' || equity.length > 0) {
      const s = summarizeRun(equity, orders);
      return {
        ...common, basis: 'rows' as const, points: s.points,
        startAda: s.startEquity !== null ? adaStr(s.startEquity) : '-', endAda: s.endEquity !== null ? adaStr(s.endEquity) : '-',
        endExecAda: s.endExecutable !== null ? adaStr(s.endExecutable) : '-', returnPct: s.returnPct ?? '-',
        endTokens: s.endBaseTokens ?? '-', returnTokenPct: s.returnBasePct ?? '-',
        filled: s.filled, rejected: s.rejected, staleRejects: s.staleRejects, feesAda: adaStr(s.feesLovelace),
      };
    }
    const s = run.summary;
    const stale = orders.filter((o) => o.result.status === 'rejected' && o.result.reason.startsWith('stale t+1')).length;
    return {
      ...common, basis: 'summary' as const, points: 0,
      startAda: s ? adaStr(s.startEquityLovelace) : '-', endAda: s ? adaStr(s.endEquityLovelace) : '-', endExecAda: '-',
      returnPct: s ? s.returnPct : '-',
      // A backtest persists orders but no equity points, so there is no price to restate against.
      // Key order matches the `rows` branch above on purpose: `console.table` derives its columns
      // from the keys of the FIRST row, so a differing order here would move the columns depending
      // on whether a backtest or a paper run happened to be listed first.
      endTokens: '-', returnTokenPct: '-',
      filled: s?.filled ?? 0, rejected: s?.rejected ?? 0, staleRejects: stale, feesAda: s ? adaStr(s.feesLovelace) : '-',
    };
  });
}

export interface SweepInput extends CompareInput { ticker: string; depthAda: number | null }
export interface SweepRow {
  ticker: string; strategy: string; runId: number; depthAda: number | string; coveragePct: string; candles: number;
  returnPct: number; maxDrawdownPct: number; filled: number; intents: number; feesAda: string; warnings: number;
}

/** One row per token x strategy, in the order run — token-major, never sorted by return. Coverage is the run's own (`candles / expectedBuckets`), so a 4% return over a 12%-dense corpus reads as what it is. */
export function sweepRows(results: SweepInput[]): SweepRow[] {
  return results.map(({ ticker, strategyId, runId, summary: s, depthAda }) => ({
    ticker, strategy: strategyId, runId, depthAda: depthAda ?? '-',
    coveragePct: s.coverage.expectedBuckets > 0 ? ((s.coverage.candles / s.coverage.expectedBuckets) * 100).toFixed(1) : '0.0',
    candles: s.candles, returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct, filled: s.filled, intents: s.intents,
    feesAda: adaStr(s.feesLovelace), warnings: (s.warnings ?? []).length,
  }));
}
