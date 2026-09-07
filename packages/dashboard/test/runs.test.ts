import type { EquityPoint, OrderRecord, RunRow, RunSummaryStats } from '@ctb/engine';
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

describe('renderRunDetail', () => {
  it('a paper run with 3 equity points and 2 orders renders the persisted-rows headline, the chart, and the orders table', () => {
    const run = makeRun({ id: 7 });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: orders2, equity: equity3, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('points');
    expect(html).toMatch(/<td>3<\/td>/); // s.points === 3
    expect(html).toContain('new uPlot(');
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
  });

  it('an unfinished run (no summary) renders "unfinished"', () => {
    const run = makeRun({ id: 9, mode: 'backtest', status: 'finished', summary: null });
    const html = renderRunDetail({ run, ticker: 'TEST', orders: [], equity: [], now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('unfinished');
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
    const html = renderRunsList({ runs: [backtestRun], tickerOf, filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('3.2'); // returnPct
    expect(html).toContain('1.1'); // maxDrawdownPct
    expect(html).toContain('4/5'); // filled/intents
    expect(html).toContain('summary'); // basis
  });

  it('an unfinished run in the list reads "unfinished" for basis and "-" for its numbers', () => {
    const html = renderRunsList({ runs: [paperRun], tickerOf, filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain('unfinished');
  });

  it('a list with one rehearsal row has the banner and the word on that row', () => {
    const html = renderRunsList({ runs: [paperRun, rehearsalRun], tickerOf, filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toContain(REHEARSAL_BANNER);
    expect(html).toContain('REHEARSAL');
  });

  it('omits the banner when no row is a rehearsal', () => {
    const html = renderRunsList({ runs: [paperRun, backtestRun], tickerOf, filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).not.toContain(REHEARSAL_BANNER);
  });

  it('the filter form echoes the current filter as selected', () => {
    const html = renderRunsList({ runs: [paperRun], tickerOf, filter: { mode: 'paper', status: 'running' }, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).toMatch(/<option value="paper" selected>paper<\/option>/);
    expect(html).toMatch(/<option value="running" selected>running<\/option>/);
    expect(html).not.toMatch(/<option value="backtest" selected>/);
  });

  it('escapes a database-sourced strategyId instead of rendering it raw', () => {
    const dodgy = makeRun({ id: 4, strategyId: '<script>alert(1)</script>' });
    const html = renderRunsList({ runs: [dodgy], tickerOf, filter: {}, page: 1, pageSize: 50, now: new Date('2026-09-07T12:00:00Z') });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
