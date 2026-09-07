/**
 * `/runs` and `/runs/:id` (spec §4.2). The list is deliberately cheap: it renders each run's own
 * `runs.summary` — already computed once, at finish time, by the engine — and never loads that run's
 * equity points or orders, so a page of 50 runs stays one query (spec's global constraint: "the
 * dashboard computes NO numbers" cuts both ways — it also never RE-fetches numbers it could instead
 * read off the row it already has). The detail page is where a paper run's headline is recomputed
 * from its persisted rows with `summarizeRun` (finding C1, `@ctb/reports`): a resumed run's
 * `runs.summary` reflects only its last segment, and an operator reading one run's page needs the
 * whole thing.
 */
import { STRATEGIES, type EquityPoint, type OrderRecord, type RunRow, type RunSummaryStats } from '@ctb/engine';
import { adaStr, coverageLine, feedCountersLine, resumesOf, summarizeRun } from '@ctb/reports';
import { chartHtml, equitySeries } from '../chart.js';
import { escape, layout, table } from '../html.js';
import { RUN_MODES, RUN_STATUSES, type RunFilter } from '../reads.js';

const PAGE_CSS_FORM = 'display:flex;gap:1rem;flex-wrap:wrap;align-items:end;margin-bottom:1rem;';

function selectField(name: string, current: string | undefined, values: readonly string[]): string {
  const options = ['<option value="">all</option>', ...values.map((v) =>
    `<option value="${escape(v)}"${v === current ? ' selected' : ''}>${escape(v)}</option>`)];
  return `<select name="${escape(name)}">${options.join('')}</select>`;
}

/**
 * The list never loads a run's rows (see file header), so it cannot know a run's ticker from the
 * database alone — `tickerOf` is a pure lookup over the universe, not a query. The strategy and
 * ticker options are built from what's actually on the page (plus the current filter value, so a
 * filter that matches zero rows still shows itself as selected) rather than the full universe, which
 * this page has no other reason to load.
 */
function renderFilterForm(filter: RunFilter, tickerOf: (unit: string) => string, runs: RunRow[]): string {
  const selectedTicker = filter.unit !== undefined ? tickerOf(filter.unit) : undefined;
  const tickers = new Set<string>(runs.map((r) => tickerOf(r.baseUnit)));
  if (selectedTicker !== undefined) tickers.add(selectedTicker);
  const strategies = new Set<string>(Object.keys(STRATEGIES));
  if (filter.strategy !== undefined) strategies.add(filter.strategy);

  return `<form method="get" action="/runs" style="${PAGE_CSS_FORM}">
<label>mode<br>${selectField('mode', filter.mode, RUN_MODES)}</label>
<label>strategy<br>${selectField('strategy', filter.strategy, [...strategies].sort())}</label>
<label>ticker<br>${selectField('ticker', selectedTicker, [...tickers].sort())}</label>
<label>status<br>${selectField('status', filter.status, RUN_STATUSES)}</label>
<button type="submit">filter</button>
</form>`;
}

export function renderRunsList(input: { runs: RunRow[]; tickerOf: (unit: string) => string; filter: RunFilter; page: number; pageSize: number; now: Date }): string {
  const { runs, tickerOf, filter, page, pageSize, now } = input;

  const rows = runs.map((r) => {
    const s = r.summary;
    return [
      // The only RenderedCell this page builds itself: a plain numeric id, escaped anyway on
      // principle (parked risk — `table()`'s unescaped branch is keyed on shape, not provenance, so
      // nothing that could ever carry a database string is allowed to construct one).
      { html: `<a href="/runs/${escape(r.id)}">${escape(r.id)}</a>` },
      r.mode,
      r.strategyId,
      tickerOf(r.baseUnit),
      r.status,
      r.createdAt.toISOString(),
      s ? s.returnPct : '-',
      s ? s.maxDrawdownPct : '-',
      s ? `${s.filled}/${s.intents}` : '-',
      s ? (s.warnings ?? []).length : '-',
      r.rehearsal ? 'REHEARSAL' : '',
      s ? 'summary' : 'unfinished',
    ];
  });

  const columns = ['id', 'mode', 'strategy', 'ticker', 'status', 'created', 'return %', 'max DD %', 'fills / intents', 'warnings', 'rehearsal', 'basis'];
  const body = `
${renderFilterForm(filter, tickerOf, runs)}
${table(columns, rows)}
<p class="asof">page ${page} (${pageSize} per page) &middot; as of ${escape(now.toISOString())}</p>`;

  const rehearsal = runs.some((r) => r.rehearsal);
  return layout('Runs', body, { rehearsal });
}

const PERSISTED_HEADLINE_COLUMNS = ['points', 'startAda', 'endAda', 'startExecAda', 'endExecAda', 'returnPct', 'filled', 'rejected', 'staleRejects', 'feesAda', 'poolFeesIn'];
const BACKTEST_HEADLINE_COLUMNS = ['candles', 'intents', 'filled', 'rejected', 'startAda', 'endAda', 'returnPct', 'maxDrawdownPct', 'lovelaceFeesAda', 'poolFeesIn'];
const ORDERS_COLUMNS = ['seq', 'intent', 'side', 'amountIn', 'status', 'fill', 'amountOut', 'slippageBps', 'priceImpactBps', 'reason'];
const ORDERS_MAX_ROWS = 200;

/** A lovelace-or-bigint-shaped value read out of an untrusted jsonb blob (`params.costs.venues`);
 * `adaStr` throws on anything that is not a valid integer string, which a hand-edited or
 * schema-drifted params blob can easily produce. Never allowed to take the whole page down. */
function safeAda(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'bigint') return '-';
  try {
    return adaStr(v);
  } catch {
    return '-';
  }
}

/** `params.costs.venues` (written by `backtest`/`paper`, see `@ctb/sim-executor`'s `VENUE_COSTS`) is
 * a jsonb blob with no schema enforcement at read time — defensive at every level, never throws. */
function costsVenuesRows(params: Record<string, unknown>): Array<Array<string>> {
  const costs = params.costs;
  if (typeof costs !== 'object' || costs === null) return [];
  const venues = (costs as Record<string, unknown>).venues;
  if (typeof venues !== 'object' || venues === null) return [];
  return Object.entries(venues as Record<string, unknown>).map(([venue, raw]) => {
    const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    return [venue, safeAda(v.batcherFeeLovelace), safeAda(v.networkFeeLovelace),
      typeof v.basis === 'string' ? v.basis : '-', typeof v.source === 'string' ? v.source : '-'];
  });
}

function renderProvenance(run: RunRow, ticker: string): string {
  const venuesRows = costsVenuesRows(run.params);
  return `<section>
<h2>provenance</h2>
<dl>
<dt>run</dt><dd>#${escape(run.id)} (${escape(ticker)})</dd>
<dt>git sha</dt><dd>${escape(run.gitSha)}</dd>
<dt>mode</dt><dd>${escape(run.mode)}</dd>
<dt>strategy</dt><dd>${escape(run.strategyId)}</dd>
<dt>source</dt><dd>${escape(run.dataSource)}</dd>
<dt>window</dt><dd>${escape(run.dataFrom.toISOString())} to ${escape(run.dataTo.toISOString())}</dd>
<dt>fill model</dt><dd>${escape(run.fillModel)}</dd>
<dt>status</dt><dd>${escape(run.status)}</dd>
<dt>created</dt><dd>${escape(run.createdAt.toISOString())}</dd>
<dt>finished</dt><dd>${run.finishedAt ? escape(run.finishedAt.toISOString()) : '-'}</dd>
</dl>
<h3>params</h3>
<pre>${escape(JSON.stringify(run.params, null, 2))}</pre>
${venuesRows.length > 0 ? `<h3>costs.venues</h3>${table(['venue', 'batcher ADA', 'network ADA', 'basis', 'source'], venuesRows)}` : ''}
</section>`;
}

function renderPaperStatusLines(run: RunRow): string {
  const resumes = resumesOf(run);
  return `<section>
<h2>status</h2>
<dl>
<dt>status</dt><dd>${escape(run.status)}</dd>
<dt>heartbeat_at</dt><dd>${run.heartbeatAt ? escape(run.heartbeatAt.toISOString()) : 'never'}</dd>
<dt>last_tick_ts</dt><dd>${run.lastTickTs ? escape(run.lastTickTs.toISOString()) : 'never'}</dd>
<dt>stop_reason</dt><dd>${run.stopReason ? escape(run.stopReason) : 'none'}</dd>
<dt>resumes</dt><dd>${resumes.length}${resumes.length > 0 ? ` (last ${escape(resumes[resumes.length - 1])})` : ''}</dd>
</dl>
<p>${escape(feedCountersLine(run.params))}</p>
</section>`;
}

/** The paper headline: every persisted equity point and order, across every segment (finding C1) —
 * never the last segment's `runs.summary`. Columns match `printPersistedHeadline` in the CLI so an
 * operator reading this page and `report <id>` never sees different labels for the same numbers. */
function renderPersistedHeadline(equity: EquityPoint[], orders: Array<OrderRecord & { baseUnit: string }>): { html: string; rejectReasons: Record<string, number> } {
  const s = summarizeRun(equity, orders);
  const row = [
    s.points,
    s.startEquity !== null ? adaStr(s.startEquity) : '-',
    s.endEquity !== null ? adaStr(s.endEquity) : '-',
    s.startExecutable !== null ? adaStr(s.startExecutable) : '-',
    s.endExecutable !== null ? adaStr(s.endExecutable) : '-',
    s.returnPct ?? '-',
    s.filled, s.rejected, s.staleRejects,
    adaStr(s.feesLovelace), s.poolFeesIn.toString(),
  ];
  return {
    html: `<section><h2>summary (from persisted rows) &mdash; run_equity + paper_orders, every segment</h2>${table(PERSISTED_HEADLINE_COLUMNS, [row])}</section>`,
    rejectReasons: s.rejectReasons,
  };
}

/** The backtest headline: `runs.summary`, columns matching `printReport`'s `console.table`. */
function renderBacktestHeadline(s: RunSummaryStats): { html: string; rejectReasons: Record<string, number> } {
  const row = [s.candles, s.intents, s.filled, s.rejected, adaStr(s.startEquityLovelace), adaStr(s.endEquityLovelace),
    s.returnPct, s.maxDrawdownPct, adaStr(s.feesLovelace), s.poolFeesIn];
  return { html: `<section><h2>summary</h2>${table(BACKTEST_HEADLINE_COLUMNS, [row])}</section>`, rejectReasons: s.rejectReasons };
}

function renderRejectReasons(reasons: Record<string, number>): string {
  const rows = Object.entries(reasons).map(([reason, count]) => [reason, count]);
  if (rows.length === 0) return '';
  return `<section><h2>reject reasons</h2>${table(['reason', 'count'], rows)}</section>`;
}

function renderOrdersTable(orders: Array<OrderRecord & { baseUnit: string }>): string {
  const rows = orders.slice(0, ORDERS_MAX_ROWS).map((o) => [
    o.seq, o.tsIntent.toISOString(), o.intent.side, o.intent.amountIn.toString(), o.result.status,
    o.result.status === 'filled' ? o.result.tsFill.toISOString() : '-',
    o.result.status === 'filled' ? o.result.amountOut.toString() : '-',
    o.result.status === 'filled' ? o.result.slippageBps : '-',
    o.result.status === 'filled' ? o.result.priceImpactBps : '-',
    o.result.status === 'rejected' ? o.result.reason : o.intent.reason,
  ]);
  const more = orders.length > ORDERS_MAX_ROWS ? `<p>&hellip; ${orders.length - ORDERS_MAX_ROWS} more orders</p>` : '';
  return `<section><h2>orders</h2>${table(ORDERS_COLUMNS, rows)}${more}</section>`;
}

function renderEquityChart(runId: number, equity: EquityPoint[]): string {
  if (equity.length < 2) return '';
  return `<section><h2>equity</h2>${chartHtml(`equity-chart-${runId}`, equitySeries(equity))}</section>`;
}

export function renderRunDetail(input: { run: RunRow; ticker: string; orders: Array<OrderRecord & { baseUnit: string }>; equity: EquityPoint[]; now: Date }): string {
  const { run, ticker, orders, equity } = input;
  const sections: string[] = [renderProvenance(run, ticker)];
  if (run.mode === 'paper') sections.push(renderPaperStatusLines(run));

  sections.push(`<p>${escape(coverageLine(run.summary?.coverage))}</p>`);
  for (const w of run.summary?.warnings ?? []) sections.push(`<p class="empty">warning: ${escape(w)}</p>`);

  let rejectReasons: Record<string, number> = {};
  if (run.mode === 'paper') {
    const headline = renderPersistedHeadline(equity, orders);
    sections.push(headline.html);
    rejectReasons = headline.rejectReasons;
  } else if (run.summary) {
    const headline = renderBacktestHeadline(run.summary);
    sections.push(headline.html);
    rejectReasons = headline.rejectReasons;
  } else {
    sections.push('<p class="empty">run has no summary (unfinished)</p>');
  }
  sections.push(renderRejectReasons(rejectReasons));

  sections.push(run.mode === 'backtest'
    ? '<p class="empty">equity is not persisted for backtest runs</p>'
    : renderEquityChart(run.id, equity));

  sections.push(renderOrdersTable(orders));

  const body = sections.filter((s) => s.length > 0).join('\n');
  return layout(`Run #${run.id}`, body, { rehearsal: run.rehearsal });
}
