import type { EquityPoint, OrderRecord, RunRow, RunSummaryStats } from '@ctb/engine';
import { adaStr, summarizeRun } from './commands/report.js';
import { heartbeatAgeCell } from './commands/status.js';

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
  filled: number; rejected: number; staleRejects: number; feesAda: string; resumes: number; rehearsal: string;
}

/**
 * One row per run, in the order given, for `report --compare`. A paper run's numbers are the same
 * persisted-rows headline `printReport` prints for it (finding C1: never the last segment's
 * `runs.summary`), so this table and `report <id>` cannot disagree. A backtest persists orders but no
 * equity points, so its row reads `runs.summary` and says so in `basis`.
 */
export function compareRunRows(inputs: CompareRunInput[], now: Date): CompareRunRow[] {
  return inputs.map(({ run, ticker, equity, orders }) => {
    const resumes = Array.isArray(run.params.resumes) ? run.params.resumes.length : 0;
    const common = {
      run: run.id, mode: run.mode, strategy: run.strategyId, ticker, status: run.status,
      // Liveness only means something for a run that claims to be alive; a finished or aborted run's last heartbeat is history.
      heartbeat: run.mode === 'paper' && run.status === 'running' ? heartbeatAgeCell(run.heartbeatAt, run.params, now) : '-',
      resumes, rehearsal: run.rehearsal ? 'REHEARSAL' : '',
    };
    if (run.mode === 'paper' || equity.length > 0) {
      const s = summarizeRun(equity, orders);
      return {
        ...common, basis: 'rows' as const, points: s.points,
        startAda: s.startEquity !== null ? adaStr(s.startEquity) : '-', endAda: s.endEquity !== null ? adaStr(s.endEquity) : '-',
        endExecAda: s.endExecutable !== null ? adaStr(s.endExecutable) : '-', returnPct: s.returnPct ?? '-',
        filled: s.filled, rejected: s.rejected, staleRejects: s.staleRejects, feesAda: adaStr(s.feesLovelace),
      };
    }
    const s = run.summary;
    const stale = orders.filter((o) => o.result.status === 'rejected' && o.result.reason.startsWith('stale t+1')).length;
    return {
      ...common, basis: 'summary' as const, points: 0,
      startAda: s ? adaStr(s.startEquityLovelace) : '-', endAda: s ? adaStr(s.endEquityLovelace) : '-', endExecAda: '-',
      returnPct: s ? s.returnPct : '-', filled: s?.filled ?? 0, rejected: s?.rejected ?? 0, staleRejects: stale, feesAda: s ? adaStr(s.feesLovelace) : '-',
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
