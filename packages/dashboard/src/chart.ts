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
