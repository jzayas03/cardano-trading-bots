import { COMPARE_REHEARSAL_BANNER, type CompareRunInput } from '@ctb/reports';
import type { EquityPoint, OrderRecord, RunRow } from '@ctb/engine';
import { describe, expect, it } from 'vitest';
import { REHEARSAL_BANNER } from '../src/html.js';
import { renderCompare } from '../src/pages/compare.js';

function makeRun(overrides: Partial<RunRow>): RunRow {
  return {
    id: 1, mode: 'paper', strategyId: 'ma-crossover', params: {}, gitSha: 'abc1234', baseUnit: 'testtoken.abcd',
    dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: new Date('2026-09-01T00:00:00Z'), dataTo: new Date('2026-09-07T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'), finishedAt: null, summary: null, status: 'running',
    heartbeatAt: new Date('2026-09-07T12:00:00Z'), lastTickTs: new Date('2026-09-07T12:00:00Z'), stopReason: null, rehearsal: false,
    ...overrides,
  };
}

const equity3: EquityPoint[] = [
  { tickTs: new Date('2026-09-01T00:00:00Z'), cashLovelace: 1_000_000_000n, positionBase: 0n, equityLovelace: 1_000_000_000n, equityExecutableLovelace: 1_000_000_000n, price: '0.5' },
  { tickTs: new Date('2026-09-01T00:10:00Z'), cashLovelace: 500_000_000n, positionBase: 900_000n, equityLovelace: 950_000_000n, equityExecutableLovelace: null, price: '0.5' },
  { tickTs: new Date('2026-09-01T00:20:00Z'), cashLovelace: 500_000_000n, positionBase: 900_000n, equityLovelace: 980_000_000n, equityExecutableLovelace: 975_000_000n, price: '0.53' },
];

const orders2: OrderRecord[] = [
  { seq: 1, tsIntent: new Date('2026-09-01T00:00:00Z'),
    intent: { side: 'buy', amountIn: 1_000_000_000n, reason: 'signal' },
    result: { status: 'filled', poolId: 'SundaeSwapV3:p', unitIn: 'lovelace', amountIn: 1_000_000_000n, unitOut: 'testtoken.abcd', amountOut: 441_500n,
      midPrice: '0.5', fillPrice: '0.5', poolFeeIn: 10_000_000n, batcherFeeLovelace: 1_000_000n, networkFeeLovelace: 200_000n,
      slippageBps: 10, priceImpactBps: 8, poolAfter: null, tsFill: new Date('2026-09-01T00:00:05Z') } },
  { seq: 2, tsIntent: new Date('2026-09-01T00:20:00Z'),
    intent: { side: 'sell', amountIn: 1n, reason: 'stop' },
    result: { status: 'rejected', reason: 'dust' } },
];

const now = new Date('2026-09-07T12:05:00Z');

function input(overrides: Partial<CompareRunInput> & { run: RunRow }): CompareRunInput {
  return { ticker: 'TEST', equity: [], orders: [], ...overrides };
}

/**
 * IMPORTANT 2 (final review): `COMPARE_COLUMNS` (the header labels, `pages/compare.ts`) and
 * `compareTableRows` (the cell builder) are two hand-maintained parallel arrays, eighteen wide. A
 * reviewer swapped `'returnPct'` and `'feesAda'` in the HEADER array ONLY — the data-cell order was
 * untouched, so a naive "check the `<td>` at hardcoded index 13" test would have kept passing (the
 * value AT that position never moved; only its label did) — and the entire 602-test suite passed,
 * including both guard tests, because nothing here pinned a cell to the column its OWN header claims:
 * the strongest assertion in this file (`renders compareRunRows as a table` above) is a regex that
 * matches any numeric cell anywhere on the page. `compareColumnIndex` reads the rendered `<th>` text to
 * find WHICH index a given column name actually sits at, and `compareRowCellsFor` extracts one run's
 * row cells by run id — combined (`cellNamed` below), a header swap moves the name to a different
 * index, and the value found there is a DIFFERENT column's data, so the assertion fails at the swapped
 * name rather than silently reading the unmoved data. Matches on `<tr><td>${runId}</td>` — the FIRST
 * cell of the row must equal the id exactly — so a run whose id is a substring of another row's `run`
 * cell (there is none in this suite, but `id: 1` inside `id: 16` would be a risk with a looser match)
 * can never be confused for a different row.
 */
function compareRowCellsFor(html: string, runId: number): string[] {
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => m[1] ?? '');
  const row = rows.find((r) => r.startsWith(`<td>${runId}</td>`));
  if (row === undefined) throw new Error(`no <tr> found for run ${runId}`);
  return [...row.matchAll(/<td>(.*?)<\/td>/g)].map((m) => m[1] ?? '');
}

function compareColumnIndex(html: string, columnName: string): number {
  const theadMatch = /<thead><tr>(.*?)<\/tr><\/thead>/.exec(html);
  if (theadMatch === null) throw new Error('no <thead><tr> found');
  const headers = [...theadMatch[1]!.matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1] ?? '');
  const idx = headers.indexOf(columnName);
  if (idx === -1) throw new Error(`column ${JSON.stringify(columnName)} not found in header row: ${headers.join(', ')}`);
  return idx;
}

describe('renderCompare', () => {
  it('never sorts: the table rows appear in the exact order the ids were listed, even out of numeric order', () => {
    const run7 = makeRun({ id: 7 });
    const run6 = makeRun({ id: 6 });
    const html = renderCompare({ inputs: [input({ run: run7, equity: equity3, orders: orders2 }), input({ run: run6, equity: equity3, orders: orders2 })], now });
    const runCells = [...html.matchAll(/<td>(\d+)<\/td>/g)].map((m) => Number(m[1]));
    // The FIRST numeric cell of each row is `run` (COMPARE_COLUMNS[0]); confirm 7 appears before 6.
    expect(runCells.indexOf(7)).toBeLessThan(runCells.indexOf(6));
  });

  it('renders the compare-specific REHEARSAL banner when any input run is a rehearsal, and omits it when none are (MINOR, final review)', () => {
    // MINOR (final review): a mixed comparison used to show the generic single-run `REHEARSAL_BANNER`
    // ("synthetic data — not evidence"), implying the whole page is synthetic; it now shows
    // `COMPARE_REHEARSAL_BANNER` ("one or more rows are synthetic data — not evidence"), the exact
    // wording `report --compare`'s `printCompare` already uses for this same case — and never the
    // generic single-run wording at all.
    const rehearsalRun = makeRun({ id: 6, rehearsal: true });
    const plainRun = makeRun({ id: 7 });
    const withRehearsal = renderCompare({ inputs: [input({ run: rehearsalRun, equity: equity3, orders: orders2 }), input({ run: plainRun, equity: equity3, orders: orders2 })], now });
    expect(withRehearsal).toContain(COMPARE_REHEARSAL_BANNER);
    expect(withRehearsal).not.toContain(REHEARSAL_BANNER);

    const withoutRehearsal = renderCompare({ inputs: [input({ run: plainRun, equity: equity3, orders: orders2 })], now });
    expect(withoutRehearsal).not.toContain(COMPARE_REHEARSAL_BANNER);
  });

  it('the heading names every id, every distinct ticker, and "as of <now>"', () => {
    const run6 = makeRun({ id: 6 });
    const run7 = makeRun({ id: 7 });
    const html = renderCompare({ inputs: [input({ run: run6, ticker: 'TEST', equity: equity3 }), input({ run: run7, ticker: 'TEST', equity: equity3 })], now });
    expect(html).toContain('compare 6,7');
    expect(html).toContain('TEST');
    expect(html).toContain(`as of ${now.toISOString()}`);
  });

  it('warns about mixed tokens with the exact wording report --compare\'s printCompare uses, only when tickers differ', () => {
    const run6 = makeRun({ id: 6 });
    const run105 = makeRun({ id: 105, mode: 'backtest' });
    const mixed = renderCompare({ inputs: [input({ run: run6, ticker: 'TEST', equity: equity3 }), input({ run: run105, ticker: 'OTHERCOIN' })], now });
    expect(mixed).toContain('warning: these runs are on different tokens; their returns are not comparable to each other');

    const single = renderCompare({ inputs: [input({ run: run6, ticker: 'TEST', equity: equity3 }), input({ run: makeRun({ id: 7 }), ticker: 'TEST', equity: equity3 })], now });
    expect(single).not.toContain('warning: these runs are on different tokens');
  });

  it('renders compareRunRows as a table — one row per run, matching its own returnPct/basis', () => {
    const run6 = makeRun({ id: 6 });
    const html = renderCompare({ inputs: [input({ run: run6, ticker: 'TEST', equity: equity3, orders: orders2 })], now });
    expect(html).toContain('<td>6</td>');
    expect(html).toContain('<td>rows</td>'); // basis: a paper run with persisted equity reads from rows
    expect(html).toMatch(/<td>-?\d+(\.\d+)?<\/td>/); // returnPct cell is numeric
  });

  it('pins the base-token columns to their own header names, and shows them disagreeing with ADA', () => {
    // `equity3` runs 1000 -> 980 ADA while the price runs 0.5 -> 0.53. In ADA that is -2%; in TOKENS
    // it is -7.54%, because the token got 6% dearer. A run can look nearly flat in ADA and be a clear
    // loss against an accumulation goal, and this is the pair of cells that says so.
    const html = renderCompare({ inputs: [input({ run: makeRun({ id: 6 }), ticker: 'TEST', equity: equity3, orders: orders2 })], now });
    const cells = compareRowCellsFor(html, 6);
    const cellNamed = (columnName: string): string | undefined => cells[compareColumnIndex(html, columnName)];
    expect(cellNamed('returnPct')).toBe('-2');
    expect(cellNamed('returnTokenPct')).toBe('-7.54');
    expect(cellNamed('endTokens')).toBe('1849.056603');
    // Read by header name, so an inserted column moves the NAME and this still reads the right cell
    // rather than silently reading its neighbour — the reason this file indexes headers at all.
    expect(cells).toHaveLength(compareColumnIndex(html, 'feesAda') + 1);
  });

  it('pins basis, startAda, endAda and returnPct to the column position their OWN header names claim (IMPORTANT 2, final review)', () => {
    const run6 = makeRun({ id: 6 });
    const html = renderCompare({ inputs: [input({ run: run6, ticker: 'TEST', equity: equity3, orders: orders2 })], now });
    const cells = compareRowCellsFor(html, 6);
    const cellNamed = (columnName: string): string | undefined => cells[compareColumnIndex(html, columnName)];
    // equity3: first point 1_000_000_000 lovelace, last point 980_000_000 lovelace -> startAda
    // 1000.000000, endAda 980.000000, returnPct (980-1000)/1000*100 = -2 (summarizeRun's own bigint
    // basis-point arithmetic, not anything this test recomputes). Looked up by the column's OWN
    // rendered header name, not a hardcoded index, so a header-only swap (the reviewer's probe) fails
    // here: the swapped name resolves to a DIFFERENT index whose data cell holds a different column's
    // value entirely.
    expect(cellNamed('basis')).toBe('rows');
    expect(cellNamed('startAda')).toBe('1000.000000');
    expect(cellNamed('endAda')).toBe('980.000000');
    expect(cellNamed('returnPct')).toBe('-2');
  });

  it('renders a backtest run (no persisted equity) with basis "summary" from runs.summary', () => {
    const backtestRun = makeRun({
      id: 105, mode: 'backtest', status: 'finished',
      summary: {
        candles: 12, intents: 2, filled: 1, rejected: 1, startEquityLovelace: '1000000000', endEquityLovelace: '1010000000',
        returnPct: 1.0, maxDrawdownPct: 0.5, feesLovelace: '2000000', poolFeesIn: '10000000', rejectReasons: {},
        coverage: { candles: 12, first: null, last: null, expectedBuckets: 12, maxGapMs: 0, gapsOverBound: 0 }, warnings: [],
      },
    });
    const html = renderCompare({ inputs: [input({ run: backtestRun, ticker: 'TEST', equity: [], orders: [] })], now });
    expect(html).toContain('<td>summary</td>');
  });

  it('renders the chart when at least one input has two or more equity points', () => {
    const run6 = makeRun({ id: 6 });
    const html = renderCompare({ inputs: [input({ run: run6, ticker: 'TEST', equity: equity3, orders: orders2 })], now });
    expect(html).toContain('new uPlot(');
    expect(html).not.toContain('no run in this comparison has enough persisted equity points to chart');
  });

  it('renders the no-equity line, and no chart, when every input has fewer than two equity points', () => {
    const run105 = makeRun({ id: 105, mode: 'backtest' });
    const run106 = makeRun({ id: 106, mode: 'backtest' });
    const run107 = makeRun({ id: 107, mode: 'backtest' });
    const html = renderCompare({
      inputs: [input({ run: run105, ticker: 'TEST' }), input({ run: run106, ticker: 'TEST' }), input({ run: run107, ticker: 'TEST' })],
      now,
    });
    expect(html).toContain('no run in this comparison has enough persisted equity points to chart');
    expect(html).not.toContain('new uPlot(');
  });

  it('escapes a database-sourced strategyId instead of rendering it raw', () => {
    const dodgy = makeRun({ id: 6, strategyId: '<script>alert(1)</script>' });
    const html = renderCompare({ inputs: [input({ run: dodgy, ticker: 'TEST', equity: equity3 })], now });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
