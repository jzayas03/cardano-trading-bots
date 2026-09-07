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
// Critical 2 (review round 1): `report <id>` prints `assumedVenuesTouched(orders)` as a warning — a
// fill against a venue with no documented batcher fee had its cost ASSUMED, and an operator reading
// only the dashboard page had no way to know that. Imported straight from `@ctb/sim-executor`, the
// same package `printReport` imports it from — never re-exported through `@ctb/reports`, which
// imports `@ctb/candles` (and so `pg`) and is required to stay free of a database driver
// (`@ctb/reports`'s own Task 1 guard pins that). `@ctb/dashboard` already depends on `pg` directly
// (via `@ctb/db`, for `PgDashboardReads`/`PgRunRepo`), so this import adds nothing new to ITS own
// dependency graph — only `@ctb/reports`'s purity would have been at risk.
import { assumedVenuesTouched } from '@ctb/sim-executor';
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
 * database alone — `tickerOf` is a pure lookup over the universe, not a query. The strategy options
 * are the full sanctioned `STRATEGIES` list (plus the current filter value, so a filter that matches
 * zero rows still shows itself as selected).
 *
 * Finding I3 (review round 1): the ticker options used to be built from `runs.map(tickerOf)` — only
 * the tickers on the CURRENT (already-filtered) page — so a ticker that only appears on page 2, or
 * that has zero runs matching the rest of the current filter, was undiscoverable through the form: an
 * operator would have to clear every filter first just to find out it existed. `tickers` is now the
 * full universe list, threaded in from `DashboardDeps.tickers()` (a pure in-memory lookup, no query —
 * the same shape as `tickerOf`/`unitOf`), so every ticker the universe knows about is always offered.
 */
function renderFilterForm(filter: RunFilter, tickerOf: (unit: string) => string, tickers: readonly string[]): string {
  const selectedTicker = filter.unit !== undefined ? tickerOf(filter.unit) : undefined;
  const tickerOptions = new Set<string>(tickers);
  if (selectedTicker !== undefined) tickerOptions.add(selectedTicker);
  const strategies = new Set<string>(Object.keys(STRATEGIES));
  if (filter.strategy !== undefined) strategies.add(filter.strategy);

  return `<form method="get" action="/runs" style="${PAGE_CSS_FORM}">
<label>mode<br>${selectField('mode', filter.mode, RUN_MODES)}</label>
<label>strategy<br>${selectField('strategy', filter.strategy, [...strategies].sort())}</label>
<label>ticker<br>${selectField('ticker', selectedTicker, [...tickerOptions].sort())}</label>
<label>status<br>${selectField('status', filter.status, RUN_STATUSES)}</label>
<button type="submit">filter</button>
</form>`;
}

/** The query string for the SAME filter, at a different `page` — used by both the filter form's
 * implicit resubmission (page 1) and the prev/next links below (whatever page they name). Encodes
 * `filter.unit` back to its display ticker via `tickerOf`, since `?ticker=` is what the URL/router
 * actually accepts (`reads.ts`'s `RunFilter.unit` only exists after the router already resolved it). */
function runsQueryString(filter: RunFilter, tickerOf: (unit: string) => string, page: number): string {
  const params = new URLSearchParams();
  if (filter.mode !== undefined) params.set('mode', filter.mode);
  if (filter.strategy !== undefined) params.set('strategy', filter.strategy);
  if (filter.unit !== undefined) params.set('ticker', tickerOf(filter.unit));
  if (filter.status !== undefined) params.set('status', filter.status);
  params.set('page', String(page));
  return `/runs?${params.toString()}`;
}

/**
 * M2 (review round 1): with more than one page of runs (129 in the live dev DB), the list had no
 * next/prev links at all — an operator had to already know `?page=` existed and hand-edit the URL,
 * with nothing on the page even hinting that further pages existed. The list deliberately never runs
 * a second (COUNT) query per page (file header: "a page of 50 runs stays one query"), so "is there a
 * next page" is inferred the same way most offset-paginated APIs without a count do: a FULL page
 * (`rowsOnPage === pageSize`) probably has more after it; a fetch that came back short is the last one.
 */
function renderPagerLinks(filter: RunFilter, tickerOf: (unit: string) => string, page: number, pageSize: number, rowsOnPage: number): string {
  const links: string[] = [];
  if (page > 1) links.push(`<a href="${escape(runsQueryString(filter, tickerOf, page - 1))}">&larr; prev</a>`);
  if (rowsOnPage === pageSize) links.push(`<a href="${escape(runsQueryString(filter, tickerOf, page + 1))}">next &rarr;</a>`);
  return links.length > 0 ? `<p class="pager">${links.join(' &middot; ')}</p>` : '';
}

export function renderRunsList(input: { runs: RunRow[]; tickerOf: (unit: string) => string; tickers: readonly string[]; filter: RunFilter; page: number; pageSize: number; now: Date }): string {
  const { runs, tickerOf, tickers, filter, page, pageSize, now } = input;

  const rows = runs.map((r) => {
    const s = r.summary;
    // Finding I4 (review round 1): a resumed run's `runs.summary` reflects only its LAST segment (the
    // same fact `renderPersistedHeadline`'s own heading already calls out on the detail page), but the
    // list column was unconditionally labelled `summary` — an operator comparing the list's return %
    // against the detail page's persisted-rows headline for the same resumed run saw two different
    // numbers with no indication either one was partial (measured: list -0.09, detail -0.16 for run 6).
    const basis = s ? (resumesOf(r).length > 0 ? 'summary (last segment)' : 'summary') : 'unfinished';
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
      basis,
    ];
  });

  const columns = ['id', 'mode', 'strategy', 'ticker', 'status', 'created', 'return %', 'max DD %', 'fills / intents', 'warnings', 'rehearsal', 'basis'];
  const body = `
${renderFilterForm(filter, tickerOf, tickers)}
${table(columns, rows)}
${renderPagerLinks(filter, tickerOf, page, pageSize, runs.length)}
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

/**
 * M3 (review round 1): a paper run with 0 or 1 persisted equity points (a run that just started, or
 * whose feed has not written a tick yet) rendered NOTHING here — no chart, no message — while the
 * backtest branch right next to it always explains itself ("equity is not persisted for backtest
 * runs"). An operator seeing a run's page end mid-section with no equity chart and no reason had no
 * way to tell "not enough data yet" apart from "the page silently dropped something".
 */
function renderEquityChart(runId: number, equity: EquityPoint[]): string {
  if (equity.length < 2) return '<section><h2>equity</h2><p class="empty">not enough persisted points to chart</p></section>';
  return `<section><h2>equity</h2>${chartHtml(`equity-chart-${runId}`, equitySeries(equity))}</section>`;
}

export function renderRunDetail(input: { run: RunRow; ticker: string; orders: Array<OrderRecord & { baseUnit: string }>; equity: EquityPoint[]; now: Date }): string {
  const { run, ticker, orders, equity } = input;
  const sections: string[] = [renderProvenance(run, ticker)];
  if (run.mode === 'paper') sections.push(renderPaperStatusLines(run));

  sections.push(`<p>${escape(coverageLine(run.summary?.coverage))}</p>`);
  for (const w of run.summary?.warnings ?? []) sections.push(`<p class="empty">warning: ${escape(w)}</p>`);
  // Same wording as `printReport`/`printDayReport`, driven by the same `orders` this page already
  // fetched — computed here (not gated on `run.summary` existing, unlike the CLI's early return) so a
  // paper run being watched mid-flight never hides an assumed cost just because it hasn't finished yet.
  const assumedVenues = assumedVenuesTouched(orders);
  if (assumedVenues.length > 0) {
    sections.push(`<p class="empty">warning: fills touched venues with ASSUMED costs: ${escape(assumedVenues.join(', '))} (see runs.params.costs.venues)</p>`);
  }

  // Finding M4 (review round 1): the paper branch always showed the persisted-rows headline (correct
  // — see finding C1, it never depends on `runs.summary`) but that branch never fell through to the
  // "unfinished" message below, so a RUNNING paper run with no `runs.summary` yet looked identical to
  // a finished one — only a backtest ever said "unfinished". `printReport` prints BOTH for exactly
  // this case (the persisted headline, then "run has no summary (unfinished)"), so the two checks
  // below are now independent: mode decides which headline (if any) to show, `!run.summary` decides
  // whether "unfinished" is ALSO shown, for either mode.
  let rejectReasons: Record<string, number> = {};
  if (run.mode === 'paper') {
    const headline = renderPersistedHeadline(equity, orders);
    sections.push(headline.html);
    rejectReasons = headline.rejectReasons;
  } else if (run.summary) {
    const headline = renderBacktestHeadline(run.summary);
    sections.push(headline.html);
    rejectReasons = headline.rejectReasons;
  }
  if (!run.summary) sections.push('<p class="empty">run has no summary (unfinished)</p>');
  sections.push(renderRejectReasons(rejectReasons));

  sections.push(run.mode === 'backtest'
    ? '<p class="empty">equity is not persisted for backtest runs</p>'
    : renderEquityChart(run.id, equity));

  sections.push(renderOrdersTable(orders));

  const body = sections.filter((s) => s.length > 0).join('\n');
  return layout(`Run #${run.id}`, body, { rehearsal: run.rehearsal });
}
