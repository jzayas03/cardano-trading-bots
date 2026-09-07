import type { RunSummaryStats } from '@ctb/engine';
import { adaStr } from './commands/report.js';

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
