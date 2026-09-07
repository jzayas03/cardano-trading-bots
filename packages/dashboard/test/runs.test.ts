import type { EquityPoint, OrderRecord, RunRow, RunSummaryStats } from '@ctb/engine';
import { assumedVenuesTouched } from '@ctb/sim-executor';
import { describe, expect, it } from 'vitest';
import { REHEARSAL_BANNER } from '../src/html.js';
import { renderRunDetail, renderRunsList } from '../src/pages/runs.js';

function makeRun(overrides: Partial<RunRow>): RunRow {
  return {
    id: 1, mode: 'paper', strategyId: 'ma-crossover', params: {}, gitSha: 'abc1234', baseUnit: 'testtoken.abcd',
    dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: new Date('2026-09-01T00:00:00Z'), dataTo: new Date('2026-09-07T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'), finishedAt: null, summary: null, status: 'running',
    heartbeatAt: new Date('2026-09-07T12:00:00Z'), lastTickTs: new Date('2026-09-07T12:00:00Z'), stopReason: null, rehearsal: false,
    ...overrides,
  };
}

const tickerOf = (unit: string): string => (unit === 'testtoken.abcd' ? 'TEST' : unit);

const backtestSummary: RunSummaryStats = {
  candles: 100, intents: 5, filled: 4, rejected: 1,
  startEquityLovelace: '1000000000', endEquityLovelace: '1032000000', returnPct: 3.2, maxDrawdownPct: 1.1,
  feesLovelace: '8000000', poolFeesIn: '40000000', rejectReasons: { dust: 1 },
  coverage: { candles: 100, first: '2026-09-01T00:00:00.000Z', last: '2026-09-05T00:00:00.000Z', expectedBuckets: 100, maxGapMs: 600_000, gapsOverBound: 0 },
  warnings: ['no trades taken'],
};

const equity3: EquityPoint[] = [
  { tickTs: new Date('2026-09-01T00:00:00Z'), cashLovelace: 1_000_000_000n, positionBase: 0n, equityLovelace: 1_000_000_000n, equityExecutableLovelace: 1_000_000_000n, price: '0.5' },
  { tickTs: new Date('2026-09-01T00:10:00Z'), cashLovelace: 500_000_000n, positionBase: 900_000n, equityLovelace: 950_000_000n, equityExecutableLovelace: null, price: '0.5' },
  { tickTs: new Date('2026-09-01T00:20:00Z'), cashLovelace: 500_000_000n, positionBase: 900_000n, equityLovelace: 980_000_000n, equityExecutableLovelace: 975_000_000n, price: '0.53' },
];

const orders2: Array<OrderRecord & { baseUnit: string }> = [
  { seq: 1, tsIntent: new Date('2026-09-01T00:00:00Z'), baseUnit: 'testtoken.abcd',
    intent: { side: 'buy', amountIn: 1_000_000_000n, reason: 'signal' },
    result: { status: 'filled', poolId: 'SundaeSwapV3:p', unitIn: 'lovelace', amountIn: 1_000_000_000n, unitOut: 'testtoken.abcd', amountOut: 441_500n,
      midPrice: '0.5', fillPrice: '0.5', poolFeeIn: 10_000_000n, batcherFeeLovelace: 1_000_000n, networkFeeLovelace: 200_000n,
      slippageBps: 10, priceImpactBps: 8, poolAfter: null, tsFill: new Date('2026-09-01T00:00:05Z') } },
  { seq: 2, tsIntent: new Date('2026-09-01T00:20:00Z'), baseUnit: 'testtoken.abcd',
    intent: { side: 'sell', amountIn: 1n, reason: 'stop' },
    result: { status: 'rejected', reason: 'dust' } },
];

/** `Fake` (a `dev:fake-collector` rehearsal pool) is not a `DexName` at all, so `assumedVenuesTouched`
 * treats it as assumed-cost the same way it would treat an undocumented real venue — the exact case
 * `report 6`/`report 7` print the warning for. */
const assumedVenueOrder: OrderRecord & { baseUnit: string } = {
  seq: 1, tsIntent: new Date('2026-09-01T00:00:00Z'), baseUnit: 'testtoken.abcd',
  intent: { side: 'buy', amountIn: 1_000_000n, reason: 'signal' },
  result: { status: 'filled', poolId: 'Fake:TEST', unitIn: 'lovelace', amountIn: 1_000_000n, unitOut: 'testtoken.abcd', amountOut: 500_000n,
    midPrice: '0.5', fillPrice: '0.5', poolFeeIn: 0n, batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n,
    slippageBps: 0, priceImpactBps: 0, poolAfter: null, tsFill: new Date('2026-09-01T00:00:05Z') },
};

describe('renderRunDetail', () => {
  // Critical 2 (review round 1): the detail page used to render only `run.summary?.warnings`, so
  // `report <id>`'s "fills touched venues with ASSUMED costs" line — printed via
  // `assumedVenuesTouched` from `@ctb/sim-executor` — appeared nowhere on the page for the same run.
  // This pins that the dashboard and the CLI agree, by checking both against the SAME `orders` array:
  // `assumedVenuesTouched` (imported here exactly as `printReport` imports it) is the source of truth,
  // and the rendered HTML must contain the identical warning line it produces.
  it('renders the same "fills touched venues with ASSUMED costs" warning report <id> prints, for the same orders', () => {
    const run = makeRun({ id: 11 });
    const orders = [assumedVenueOrder];
    const expectedVenues = assumedVenuesTouched(orders);
    expect(expectedVenues).toEqual(['Fake']);

    const html = renderRunDetail({ run, ticker: 'TEST', orders, equity: equity3, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain(`warning: fills touched venues with ASSUMED costs: ${expectedVenues.join(', ')} (see runs.params.costs.venues)`);
  });

  it('renders no assumed-venue warning when no filled order touches an assumed-cost venue', () => {
    const run = makeRun({ id: 12 });
    // orders2's one fill is against SundaeSwapV3, a `documented`-basis venue (see VENUE_COSTS).
    expect(assumedVenuesTouched(orders2)).toEqual([]);
    const html = renderRunDetail({ run, ticker: 'TEST', orders: orders2, equity: equity3, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).not.toContain('ASSUMED costs');
  });

  it('a paper run with 3 equity points and 2 orders renders the persisted-rows headline, the chart, and the orders table', () => {
    const run = makeRun({ id: 7 });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: orders2, equity: equity3, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('points');
    expect(html).toMatch(/<td>3<\/td>/); // s.points === 3
    expect(html).toContain('new uPlot(');
    // IMPORTANT 2 (final review): `new uPlot(` alone proves nothing — both task reports that shipped
    // this chart asserted exactly that and it was true while the library was never loaded, throwing
    // `ReferenceError: uPlot is not defined` in a real browser. The page must also reference the
    // script that DEFINES `uPlot`, or the inline call above has nothing to call.
    expect(html).toContain('<script src="/vendor/uPlot.iife.min.js"></script>');
    expect(html).toContain('dust');
    expect(html).not.toContain(REHEARSAL_BANNER);
  });

  it('renders the REHEARSAL banner for a rehearsal run', () => {
    const run = makeRun({ id: 7, rehearsal: true });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: orders2, equity: equity3, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain(REHEARSAL_BANNER);
  });

  it('a backtest run renders "equity is not persisted for backtest runs" and the runs.summary headline', () => {
    const run = makeRun({ id: 82, mode: 'backtest', strategyId: 'rsi-mean-reversion', status: 'finished', summary: backtestSummary });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: [], equity: [], now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('equity is not persisted for backtest runs');
    expect(html).toContain('rsi-mean-reversion');
    expect(html).toMatch(/<td>3\.2<\/td>/); // returnPct
    expect(html).toMatch(/<td>1\.1<\/td>/); // maxDrawdownPct
    expect(html).toContain('no trades taken'); // summary.warnings
    expect(html).toContain('dust'); // rejectReasons
    // IMPORTANT 2 (final review): a backtest never has a chart — it must not pay for uPlot's script.
    expect(html).not.toContain('uPlot.iife.min.js');
  });

  it('an unfinished run (no summary) renders "unfinished"', () => {
    const run = makeRun({ id: 9, mode: 'backtest', status: 'finished', summary: null });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: [], equity: [], now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('unfinished');
  });

  // Finding M4 (review round 1): the paper branch always rendered the persisted-rows headline and
  // never fell through to the "unfinished" message, so a RUNNING paper run with no `runs.summary` yet
  // looked exactly like a finished one on this point — only a backtest ever said "unfinished".
  // `printReport` prints BOTH the persisted headline and "unfinished" for this exact case.
  it('a paper run with no summary yet still renders "unfinished", alongside its persisted-rows headline', () => {
    const run = makeRun({ id: 13, mode: 'paper', summary: null });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: orders2, equity: equity3, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('unfinished');
    expect(html).toContain('summary (from persisted rows)'); // the headline is still shown
  });

  /**
   * CRITICAL 1 (final review). Measured on rehearsal run 6 (one resume, 27 persisted equity points,
   * 2 fills): `report 6` printed the persisted-rows headline (return -0.16) AND, below it, the stored
   * `runs.summary` table (return -0.09) under the heading naming it the last segment only — while
   * `/runs/6` showed ONLY the persisted headline (-0.16), so the list's own number (-0.09, which is
   * `runs.summary.returnPct`, the same field `/runs`'s `basis: summary (last segment)` row reads) never
   * appeared anywhere on the page the list links to. This fixture reproduces that shape with distinct,
   * hand-picked numbers on each side (persisted: -2, from `equity3`/`orders2`; segment: 3.2, from
   * `backtestSummary`) so a regression that drops either table, or a future edit that lets one number
   * silently overwrite the other, fails this test instead of only showing up on a live resumed run.
   */
  it('a resumed paper run renders BOTH the persisted-rows headline and the last-segment runs.summary table, with distinct numbers', () => {
    const run = makeRun({ id: 6, mode: 'paper', status: 'finished', summary: backtestSummary, params: { resumes: ['2026-09-06T18:32:00.000Z'] } });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: orders2, equity: equity3, now: new Date('2026-09-07T12:00:00Z') });
    // The persisted-rows headline: summarizeRun(equity3, orders2) has a whole-run return of -2%.
    expect(html).toContain('summary (from persisted rows)');
    expect(html).toMatch(/<td>-2<\/td>/);
    // The last-segment runs.summary table, under the CLI's own heading wording, with its OWN number
    // (3.2, distinct from the persisted -2) and the resume count.
    expect(html).toContain('last segment summary (runs.summary — the segment that last wrote it, NOT the whole run; resumes: 1)');
    expect(html).toMatch(/<td>3\.2<\/td>/);
  });

  it('a finished paper run (summary present) does not render "unfinished"', () => {
    const run = makeRun({ id: 14, mode: 'paper', status: 'finished', summary: backtestSummary });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: orders2, equity: equity3, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).not.toContain('unfinished');
  });

  // Finding M3 (review round 1): a paper run with fewer than two persisted equity points rendered
  // NOTHING for the equity section — no chart, no message — while the backtest branch right next to it
  // always explains itself. An empty section reads as "the page silently dropped something", not "not
  // enough data yet".
  it('a paper run with fewer than two equity points explains why there is no chart', () => {
    const run = makeRun({ id: 15, mode: 'paper' });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: [], equity: [equity3[0]!], now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('not enough persisted points to chart');
    expect(html).not.toContain('new uPlot(');
    // IMPORTANT 2 (final review): no chart on this page, so no reason to load its 51 KB script.
    expect(html).not.toContain('uPlot.iife.min.js');
  });

  it('a paper run with zero equity points also explains why there is no chart', () => {
    const run = makeRun({ id: 16, mode: 'paper' });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: [], equity: [], now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('not enough persisted points to chart');
    expect(html).not.toContain('uPlot.iife.min.js');
  });

  // Finding M5 (review round 1): the `<pre>` block around `run.params` was already escaped in the
  // source, but nothing pinned it — a future edit could drop the `escape()` call and nothing would
  // fail until a run's params happened to carry an HTML-significant character.
  it('escapes an HTML-significant character in run.params instead of rendering it raw in the <pre> block', () => {
    const run = makeRun({ id: 17, params: { note: '<script>alert(1)</script>' } });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: [], equity: [], now: new Date('2026-09-07T12:00:00Z') });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes a database-sourced stop_reason and reject reason instead of rendering them raw', () => {
    const run = makeRun({ id: 10, stopReason: '<script>alert(1)</script>' });
    const orders: Array<OrderRecord & { baseUnit: string }> = [
      { seq: 1, tsIntent: new Date('2026-09-01T00:00:00Z'), baseUnit: 'testtoken.abcd',
        intent: { side: 'buy', amountIn: 1n, reason: '<img onerror=alert(1)>' },
        result: { status: 'rejected', reason: '<b>dust</b>' } },
    ];
    const html = renderRunDetail({ run, ticker: 'TEST', orders, equity: [], now: new Date('2026-09-07T12:00:00Z') });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img onerror=alert(1)>');
    expect(html).not.toContain('<b>dust</b>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderRunsList', () => {
  const paperRun = makeRun({ id: 1, summary: null });
  const backtestRun = makeRun({ id: 2, mode: 'backtest', status: 'finished', summary: backtestSummary });
  const rehearsalRun = makeRun({ id: 3, rehearsal: true });

  it('renders return %, max DD %, fills / intents, and basis from runs.summary alone (no rows fetched)', () => {
    const html = renderRunsList({ runs: [backtestRun], tickerOf, tickers: ['TEST'], filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('3.2'); // returnPct
    expect(html).toContain('1.1'); // maxDrawdownPct
    expect(html).toContain('4/5'); // filled/intents
    expect(html).toContain('summary'); // basis
  });

  /**
   * IMPORTANT 4 (final review). The final reviewer swapped `return %` and `max DD %` on this list —
   * no arithmetic changed, no import changed — and every existing test here still passed, because they
   * only ever asserted the two numbers appeared SOMEWHERE on the page (the test right above this one:
   * `toContain('3.2')`/`toContain('1.1')`), which is true regardless of which column each one landed
   * in. This test instead reads the actual `<td>` cell at each column's own POSITION (via the column
   * header order `renderRunsList` itself defines) and pins it to the summary field that column claims
   * to show, using two distinctive values (7.77 and -2.22, neither of which appears elsewhere in this
   * fixture) so a swap of the two columns fails here even though the guard tests (which check
   * provenance — that a number came from `@ctb/reports`/`runs.summary` — not placement) would stay
   * green. Proved red by swapping `s.returnPct`/`s.maxDrawdownPct` in `renderRunsList`'s row array and
   * confirming this test (and only this test) failed, then restoring the file byte-exact.
   */
  it('pins the return % cell to summary.returnPct and the max DD % cell to summary.maxDrawdownPct, by column position', () => {
    const distinctSummary: RunSummaryStats = { ...backtestSummary, returnPct: 7.77, maxDrawdownPct: -2.22 };
    const run = makeRun({ id: 21, mode: 'backtest', status: 'finished', summary: distinctSummary });
    const html = renderRunsList({ runs: [run], tickerOf, tickers: ['TEST'], filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    const columns = ['id', 'mode', 'strategy', 'ticker', 'status', 'created', 'return %', 'max DD %', 'fills / intents', 'warnings', 'rehearsal', 'basis'];
    const cells = [...html.matchAll(/<td>(.*?)<\/td>/gs)].map((m) => m[1]);
    expect(cells).toHaveLength(columns.length);
    expect(cells[columns.indexOf('return %')]).toBe(String(distinctSummary.returnPct));
    expect(cells[columns.indexOf('max DD %')]).toBe(String(distinctSummary.maxDrawdownPct));
  });

  it('an unfinished run in the list reads "unfinished" for basis and "-" for its numbers', () => {
    const html = renderRunsList({ runs: [paperRun], tickerOf, tickers: ['TEST'], filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('unfinished');
  });

  it('a list with one rehearsal row has the banner and the word on that row', () => {
    const html = renderRunsList({ runs: [paperRun, rehearsalRun], tickerOf, tickers: ['TEST'], filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain(REHEARSAL_BANNER);
    expect(html).toContain('REHEARSAL');
  });

  it('omits the banner when no row is a rehearsal', () => {
    const html = renderRunsList({ runs: [paperRun, backtestRun], tickerOf, tickers: ['TEST'], filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).not.toContain(REHEARSAL_BANNER);
  });

  it('the filter form echoes the current filter as selected', () => {
    const html = renderRunsList({ runs: [paperRun], tickerOf, tickers: ['TEST'], filter: { mode: 'paper', status: 'running' }, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toMatch(/<option value="paper" selected>paper<\/option>/);
    expect(html).toMatch(/<option value="running" selected>running<\/option>/);
    expect(html).not.toMatch(/<option value="backtest" selected>/);
  });

  it('escapes a database-sourced strategyId instead of rendering it raw', () => {
    const dodgy = makeRun({ id: 4, strategyId: '<script>alert(1)</script>' });
    const html = renderRunsList({ runs: [dodgy], tickerOf, tickers: ['TEST'], filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  // Finding I3 (review round 1): the ticker `<select>` options used to be built from `runs.map
  // (tickerOf)` — only the tickers on the CURRENT page — so a ticker that only appears elsewhere was
  // undiscoverable through the form without first clearing every filter. `tickers` is now the full
  // universe list, independent of which runs are on this particular page.
  it('offers every universe ticker in the filter form, not only the tickers on the current page', () => {
    const html = renderRunsList({ runs: [paperRun], tickerOf, tickers: ['TEST', 'OTHERCOIN'], filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toMatch(/<option value="OTHERCOIN">OTHERCOIN<\/option>/);
    expect(html).toMatch(/<option value="TEST">TEST<\/option>/);
  });

  // Finding I4 (review round 1): the list's `basis` column read `summary` unconditionally, even for a
  // resumed run whose `runs.summary` is only its LAST segment — the same run's return % on the list
  // (from `runs.summary`) and on the detail page (from `summarizeRun` over every persisted segment) can
  // legitimately differ, and the list gave no hint either number was partial (measured: list -0.09,
  // detail -0.16 for run 6).
  it('a resumed run reads "summary (last segment)" for basis, not plain "summary"', () => {
    const resumedRun = makeRun({ id: 5, mode: 'backtest', status: 'finished', summary: backtestSummary, params: { resumes: ['2026-09-02T00:00:00.000Z'] } });
    const html = renderRunsList({ runs: [resumedRun], tickerOf, tickers: ['TEST'], filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('summary (last segment)');
  });

  it('a non-resumed finished run still reads plain "summary" for basis', () => {
    const html = renderRunsList({ runs: [backtestRun], tickerOf, tickers: ['TEST'], filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toMatch(/<td>summary<\/td>/);
    expect(html).not.toContain('last segment');
  });

  // Finding M2 (review round 1): with a full page of results, an operator had no way to reach the
  // next page except by hand-editing `?page=` — nothing on the page even hinted more runs existed.
  it('shows a next link when the page is full, and a prev link on any page after the first', () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => makeRun({ id: i + 1 }));
    const html = renderRunsList({ runs: fullPage, tickerOf, tickers: ['TEST'], filter: {}, page: 2, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toMatch(/href="\/runs\?page=3">next/);
    expect(html).toMatch(/href="\/runs\?page=1">.*prev/);
  });

  it('shows no next link when the page is short (the last page)', () => {
    const html = renderRunsList({ runs: [paperRun], tickerOf, tickers: ['TEST'], filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).not.toContain('next');
    expect(html).not.toContain('prev');
  });
});
