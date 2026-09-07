/**
 * `/compare?ids=…` (spec §4.2): several runs' persisted headlines in one table, and their equity
 * curves on one chart, so an operator can see whether a strategy change actually helped without
 * opening each run's own page and doing the arithmetic by eye. Every number in the table is
 * `compareRunRows`' own return value — the identical function `report --compare` calls — so this page
 * and the CLI can never disagree about a run's headline; the only arithmetic this file's own code
 * triggers is `normalisedEquitySeries`/`multiChartHtml` in `chart.ts`, the one file the one-rule guard
 * exempts (building the heading string below is concatenation, not a computed figure).
 *
 * Order is the order the operator listed the ids in — never sorted, and never re-derived from
 * `compareRunRows`' own return value, which could tempt a re-sort by run id.
 */
import { compareRunRows, type CompareRunInput, type CompareRunRow } from '@ctb/reports';
import { multiChartHtml, normalisedEquitySeries } from '../chart.js';
import { escape, layout, table } from '../html.js';

/**
 * The exact property order `compareRunRows` (packages/reports/src/compare.ts) builds a `CompareRunRow`
 * in — `run, mode, strategy, ticker, status, heartbeat` from its `common` object literal, then
 * `resumes, rehearsal` (also part of `common`), then `basis, points, startAda, endAda, endExecAda,
 * returnPct, filled, rejected, staleRejects, feesAda` from whichever branch returns. `printCompare`'s
 * `console.table` renders an object's OWN keys in this same insertion order, so matching it here is
 * what makes this page and `report --compare`'s output line up CELL FOR CELL, not merely value for
 * value under a different arrangement.
 */
const COMPARE_COLUMNS = [
  'run', 'mode', 'strategy', 'ticker', 'status', 'heartbeat', 'resumes', 'rehearsal',
  'basis', 'points', 'startAda', 'endAda', 'endExecAda', 'returnPct', 'filled', 'rejected', 'staleRejects', 'feesAda',
];

/** One row per `CompareRunRow`, in the exact column order above — every cell is a plain scalar
 * already computed by `compareRunRows`, so it goes through `table()`'s escaped path like every other
 * page's cells; nothing here is a `RenderedCell` because nothing here needs pre-rendered HTML. */
function compareTableRows(rows: CompareRunRow[]): Array<Array<string | number>> {
  return rows.map((r) => [
    r.run, r.mode, r.strategy, r.ticker, r.status, r.heartbeat, r.resumes, r.rehearsal,
    r.basis, r.points, r.startAda, r.endAda, r.endExecAda, r.returnPct, r.filled, r.rejected, r.staleRejects, r.feesAda,
  ]);
}

export function renderCompare(input: { inputs: CompareRunInput[]; now: Date }): string {
  const { inputs, now } = input;
  const ids = inputs.map((i) => i.run.id);
  const tickers = [...new Set(inputs.map((i) => i.ticker))];
  const rehearsal = inputs.some((i) => i.run.rehearsal);

  const heading = `compare ${ids.join(',')} | ${tickers.join(', ')} | as of ${now.toISOString()}`;
  const sections: string[] = [`<p>${escape(heading)}</p>`];

  // Worded EXACTLY as `report --compare`'s `printCompare` (packages/cli/src/commands/report.ts) —
  // an operator reading this page and the CLI output for the same ids must see the identical warning.
  if (tickers.length > 1) {
    sections.push('<p class="empty">warning: these runs are on different tokens; their returns are not comparable to each other</p>');
  }

  const rows = compareRunRows(inputs, now);
  sections.push(table(COMPARE_COLUMNS, compareTableRows(rows)));

  const series = normalisedEquitySeries(inputs.map((i) => ({ label: `run ${i.run.id} ${i.run.strategyId}`, points: i.equity })));
  if (series.length > 0) {
    sections.push(`<section><h2>equity (normalised to each run's own start)</h2>${multiChartHtml('compare-chart', series)}</section>`);
  } else {
    sections.push('<p class="empty">no run in this comparison has enough persisted equity points to chart</p>');
  }

  const body = sections.join('\n');
  return layout(`Compare ${ids.join(',')}`, body, { rehearsal, chart: series.length > 0 });
}
