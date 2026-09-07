import type { RunSummaryStats } from '@ctb/engine';
import { adaStr } from './format.js';

/** All combinations, first key slowest-varying. `{}` yields exactly one empty combination (no grid = one run). */
export function gridCombinations(grid: Record<string, number[]>): Array<Record<string, number>> {
  let combos: Array<Record<string, number>> = [{}];
  for (const [key, values] of Object.entries(grid)) {
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
  }
  return combos;
}

export interface GridInput { combo: Record<string, number>; runId: number; summary: RunSummaryStats }
export interface GridRow { runId: number; params: string; returnPct: number; maxDrawdownPct: number; filled: number; intents: number; feesAda: string; warnings: number }

/**
 * One row per combination, in run order — never sorted by return. The best row of N tried on the
 * same window is optimistic by construction (the caller prints that sentence above the table, and
 * every run carries `grid.size` in its params so a reader of one run alone knows it was one of N).
 */
export function gridRows(results: GridInput[]): GridRow[] {
  return results.map(({ combo, runId, summary: s }) => ({
    runId, params: Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(' '),
    returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct, filled: s.filled, intents: s.intents, feesAda: adaStr(s.feesLovelace), warnings: (s.warnings ?? []).length,
  }));
}

export function gridWarning(n: number, windowLabel: string): string {
  return `warning: ${n} parameter combinations were tried on the same window (${windowLabel}); the best of them is optimistic by construction (selection on the data it is measured on) and says nothing about any other window`;
}
