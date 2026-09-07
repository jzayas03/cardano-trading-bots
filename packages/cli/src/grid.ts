import type { RunSummaryStats } from '@ctb/engine';
import { adaStr } from './commands/report.js';

/**
 * `--grid fast=6,12,24` (repeatable): every listed value for that param. Combinations are the
 * Cartesian product across all `--grid` flags, in the order given — first flag slowest-varying —
 * so run ids read in a predictable order. A value that is not a finite number, an empty list, or a
 * param named twice is refused rather than silently shrinking the grid.
 */
export function parseGridArg(raw: string | undefined, existing: Record<string, number[]>): Record<string, number[]> {
  const eq = (raw ?? '').indexOf('=');
  const key = eq > 0 ? raw!.slice(0, eq).trim() : '';
  const list = eq > 0 ? raw!.slice(eq + 1) : '';
  if (!key || list.trim() === '') throw new Error(`--grid needs key=v1,v2,... got ${raw ?? '(missing)'}`);
  if (existing[key]) throw new Error(`--grid ${key} given more than once`);
  const values = list.split(',').map((v) => {
    const n = Number(v.trim());
    if (v.trim() === '' || !Number.isFinite(n)) throw new Error(`--grid ${key}: ${JSON.stringify(v)} is not a number`);
    return n;
  });
  const dup = values.find((v, i) => values.indexOf(v) !== i);
  if (dup !== undefined) throw new Error(`--grid ${key}: ${dup} listed more than once`);
  return { ...existing, [key]: values };
}

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
