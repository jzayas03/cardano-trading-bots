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

export { gridCombinations, gridRows, gridWarning, type GridInput, type GridRow } from '@ctb/reports';
