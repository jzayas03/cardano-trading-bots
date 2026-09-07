/**
 * The equity chart. `equitySeries` is the ONE place in this package where a lovelace amount becomes
 * a float — for uPlot to plot, nothing else — and even here it goes through `adaStr` first (spec
 * §4.1's carve-out, pinned by `oneRule.guard.test.ts`): `Number(adaStr(x))` reads the exact decimal
 * string `adaStr` already produces, it does not divide a bigint by `1_000_000` itself.
 */
import { adaStr } from '@ctb/reports';
import type { EquityPoint } from '@ctb/engine';
import { escape } from './html.js';

export interface EquitySeries {
  /** Seconds since epoch — uPlot's x-axis unit, not milliseconds. */
  ts: number[];
  equityAda: number[];
  /** Null where the executor could not price the position (`equityExecutableLovelace` is null). */
  execAda: Array<number | null>;
}

export function equitySeries(points: EquityPoint[]): EquitySeries {
  return {
    ts: points.map((p) => Math.floor(p.tickTs.getTime() / 1000)),
    equityAda: points.map((p) => Number(adaStr(p.equityLovelace))),
    execAda: points.map((p) => (p.equityExecutableLovelace === null ? null : Number(adaStr(p.equityExecutableLovelace)))),
  };
}

/** `id` is always constructed by this package's own page code (e.g. `equity-chart-42`), never a raw
 * database value — escaped anyway on the same principle `html.ts` applies everywhere else. */
export function chartHtml(id: string, series: EquitySeries): string {
  const data = JSON.stringify([series.ts, series.equityAda, series.execAda]);
  const elId = JSON.stringify(id);
  return `<div id="${escape(id)}" style="width:900px;max-width:100%"></div>
<script>
new uPlot({ width: 900, height: 300, series: [{}, { label: 'equity ADA' }, { label: 'executable ADA' }] }, ${data}, document.getElementById(${elId}));
</script>`;
}

/** One run's equity, re-expressed as a percentage of its OWN first persisted point — so two runs
 * started with very different starting cash can share one y-axis on `/compare`'s chart (spec §4.2).
 * `label` is opaque to this module; `pages/compare.ts` builds it as `run <id> <strategy>` and this
 * file only ever echoes it back into the uPlot series options. */
export interface NormalisedSeries {
  /** Seconds since epoch — uPlot's x-axis unit, not milliseconds. */
  ts: number[];
  label: string;
  /** `null` at every point of a run whose first equity value is 0 lovelace — there is no percentage
   * of nothing, so this is never computed by dividing by zero. */
  pct: Array<number | null>;
}

/**
 * A run with fewer than two persisted equity points contributes no series at all (nothing to draw a
 * line through, and the run's own page already says so — `pages/runs.ts`'s `renderEquityChart`).
 * Otherwise: `Number(adaStr(p.equityLovelace))` exactly as `equitySeries` above reads a lovelace
 * amount, then `((v / v0) - 1) * 100` against THIS run's own first value — never against another
 * run's, and never against a database-computed percentage, so two runs of very different cash sizes
 * that both double land on the identical `pct` curve ending at 100.
 */
export function normalisedEquitySeries(runs: Array<{ label: string; points: EquityPoint[] }>): NormalisedSeries[] {
  const out: NormalisedSeries[] = [];
  for (const { label, points } of runs) {
    if (points.length < 2) continue;
    const ts = points.map((p) => Math.floor(p.tickTs.getTime() / 1000));
    const v0 = Number(adaStr(points[0]!.equityLovelace));
    const pct: Array<number | null> = v0 === 0
      ? points.map(() => null)
      : points.map((p) => ((Number(adaStr(p.equityLovelace)) / v0) - 1) * 100);
    out.push({ ts, label, pct });
  }
  return out;
}

/**
 * `JSON.stringify` escapes quotes and backslashes for JS-string safety, but not `<` — so a value
 * that reaches this file from a database column (a `NormalisedSeries.label` built from
 * `run.strategyId` — see `pages/compare.ts`) and happens to contain `</script>` would otherwise
 * close the inline script block early, the same category of bug `escape()`'s HTML-entity escaping
 * exists to prevent for `<td>` content. `<` only ever appears here inside a JSON string value (the
 * surrounding array/object syntax has no use for the character), so replacing it with its JSON/JS
 * unicode escape neutralises the break-out without changing what the JSON decodes back to.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * One uPlot instance, several lines. Each `NormalisedSeries` carries its OWN `ts` array (different
 * runs can start and tick at different times), so the shared x-axis this function builds is the union
 * of every series' timestamps, sorted ascending; a series with no point at a given timestamp gets
 * `null` there rather than an interpolated or misaligned value. `id` is always constructed by this
 * package's own page code, never a raw database value — escaped anyway on the same principle
 * `chartHtml` above applies. `series[].label`, unlike `id`, IS database-derived (see `jsonForScript`
 * above), so it goes through that escape rather than `escape()` — this is a `<script>` context, not
 * an HTML attribute or text node.
 */
export function multiChartHtml(id: string, series: NormalisedSeries[]): string {
  const allTs = [...new Set(series.flatMap((s) => s.ts))].sort((a, b) => a - b);
  const aligned = series.map((s) => {
    const byTs = new Map(s.ts.map((t, i) => [t, s.pct[i] ?? null]));
    return allTs.map((t) => byTs.get(t) ?? null);
  });
  const data = jsonForScript([allTs, ...aligned]);
  const elId = jsonForScript(id);
  const seriesOpts = jsonForScript([{}, ...series.map((s) => ({ label: s.label }))]);
  return `<div id="${escape(id)}" style="width:900px;max-width:100%"></div>
<script>
new uPlot({ width: 900, height: 300, series: ${seriesOpts} }, ${data}, document.getElementById(${elId}));
</script>`;
}
