import type { EquityPoint, OrderRecord, RunRow } from '@ctb/engine';
import { describe, expect, it, vi } from 'vitest';
import { parseCompareList, parseReportArgs, printCompare } from '../src/commands/report.js';
import { compareRunRows } from '../src/compare.js';

const now = new Date('2026-09-07T12:00:00Z');
const run = (over: Partial<RunRow>): RunRow => ({
  id: 1, mode: 'paper', strategyId: 'ma-crossover', gitSha: 'abc', baseUnit: 'u', dataSource: 'candles', fillModel: 'cpmm_observed',
  dataFrom: new Date(0), dataTo: new Date(1), params: { intervalSec: 600, graceSec: 60 }, createdAt: new Date(0), finishedAt: null, summary: null,
  status: 'running', heartbeatAt: new Date('2026-09-07T11:59:00Z'), lastTickTs: null, stopReason: null, rehearsal: false, ...over,
} as RunRow);
const eq = (m: number, equity: bigint, exec: bigint | null): EquityPoint => ({ tickTs: new Date(Date.UTC(2026, 8, 7, 0, m)), cashLovelace: equity, positionBase: 0n, equityLovelace: equity, equityExecutableLovelace: exec, price: '1' });
const filled: OrderRecord = { seq: 1, tsIntent: new Date(0), intent: { side: 'buy', amountIn: 1n, reason: 'x' },
  result: { status: 'filled', poolId: 'p', unitIn: 'lovelace', amountIn: 1n, unitOut: 'u', amountOut: 1n, midPrice: '1', fillPrice: '1', poolFeeIn: 0n, batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n, slippageBps: 0, priceImpactBps: 0, poolAfter: null, tsFill: new Date(0) } };
const stale: OrderRecord = { seq: 2, tsIntent: new Date(0), intent: { side: 'buy', amountIn: 1n, reason: 'x' }, result: { status: 'rejected', reason: 'stale t+1 (gap 20m)' } };
const dust: OrderRecord = { seq: 3, tsIntent: new Date(0), intent: { side: 'buy', amountIn: 1n, reason: 'x' }, result: { status: 'rejected', reason: 'dust' } };

describe('compareRunRows', () => {
  it('a paper run reads the persisted rows: return from first to last equity point, fills, stale sub-count, fees, heartbeat, resumes', () => {
    const [row] = compareRunRows([{ run: run({ params: { intervalSec: 600, graceSec: 60, resumes: ['a', 'b'] } }), ticker: 'SNEK', equity: [eq(0, 1_000_000_000n, 1_000_000_000n), eq(10, 1_050_000_000n, 1_047_000_000n)], orders: [filled, stale, dust] }], now);
    expect(row).toEqual({
      run: 1, mode: 'paper', strategy: 'ma-crossover', ticker: 'SNEK', status: 'running', heartbeat: '60', basis: 'rows', points: 2,
      startAda: '1000.000000', endAda: '1050.000000', endExecAda: '1047.000000', returnPct: 5,
      // These points are priced at 1 ADA/token throughout, so 1050 ADA is 1050 tokens and the token
      // return must equal the ADA return exactly — the flat-price invariant, seen from the table.
      endTokens: '1050.000000', returnTokenPct: 5,
      // One filled BUY and no sells: zero completed round trips, so the gate bars it — and names the
      // count rather than calling ma-crossover a baseline, which it is not.
      promotion: 'experimental', blocker: '0 of 30 round trips',
      filled: 1, rejected: 2, staleRejects: 1, feesAda: '2.200000', resumes: 2, rehearsal: '',
    });
  });
  it('a stale paper run shows STALE with its age; a run with no equity yet shows dashes', () => {
    const [row] = compareRunRows([{ run: run({ heartbeatAt: new Date('2026-09-07T10:00:00Z') }), ticker: 'SNEK', equity: [], orders: [] }], now);
    expect(row).toMatchObject({ heartbeat: 'STALE (7200s)', points: 0, startAda: '-', endAda: '-', returnPct: '-' });
    // a finished run's last heartbeat is history, not liveness
    const [done] = compareRunRows([{ run: run({ status: 'finished', heartbeatAt: new Date('2026-09-07T10:00:00Z') }), ticker: 'SNEK', equity: [], orders: [] }], now);
    expect(done?.heartbeat).toBe('-');
  });
  it('a backtest run falls back to runs.summary and says so in basis', () => {
    const summary = { candles: 10, intents: 3, filled: 2, rejected: 1, startEquityLovelace: '1000000000', endEquityLovelace: '900000000', returnPct: -10, maxDrawdownPct: 12,
      feesLovelace: '4400000', poolFeesIn: '0', rejectReasons: { 'stale t+1 (gap 20m)': 1 }, coverage: { candles: 10, first: null, last: null, expectedBuckets: 10, maxGapMs: 0, gapsOverBound: 0 }, warnings: [] };
    const [row] = compareRunRows([{ run: run({ id: 12, mode: 'backtest', strategyId: 'rsi-mean-reversion', status: 'finished', summary }), ticker: 'SNEK', equity: [], orders: [filled, filled, stale] }], now);
    expect(row).toEqual({
      run: 12, mode: 'backtest', strategy: 'rsi-mean-reversion', ticker: 'SNEK', status: 'finished', heartbeat: '-', basis: 'summary', points: 0,
      startAda: '1000.000000', endAda: '900.000000', endExecAda: '-', returnPct: -10,
      // A backtest persists orders but no equity points, so there is no price to restate against.
      endTokens: '-', returnTokenPct: '-',
      promotion: 'experimental', blocker: '0 of 30 round trips',
      filled: 2, rejected: 1, staleRejects: 1, feesAda: '4.400000', resumes: 0, rehearsal: '',
    });
  });
  it('keeps the operator\'s order and marks a rehearsal row', () => {
    const rows = compareRunRows([
      { run: run({ id: 7, rehearsal: true }), ticker: 'SNEK', equity: [], orders: [] },
      { run: run({ id: 6 }), ticker: 'SNEK', equity: [], orders: [] },
    ], now);
    expect(rows.map((r) => [r.run, r.rehearsal])).toEqual([[7, 'REHEARSAL'], [6, '']]);
  });
});

describe('printCompare', () => {
  it('prints the REHEARSAL banner when any row is synthetic, and warns on mixed tokens', () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m: string) => { lines.push(String(m)); });
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    printCompare([{ run: run({ id: 7, rehearsal: true }), ticker: 'SNEK', equity: [], orders: [] }, { run: run({ id: 8 }), ticker: 'HOSKY', equity: [], orders: [] }], now);
    expect(lines[0]).toBe('REHEARSAL — one or more rows are synthetic data — not evidence');
    expect(lines[1]).toBe('\n=== compare 7,8 | SNEK, HOSKY | as of 2026-09-07T12:00:00.000Z');
    expect(lines[2]).toMatch(/different tokens/);
    expect(table).toHaveBeenCalledTimes(1);
    log.mockRestore(); table.mockRestore();
  });
});

describe('parseReportArgs --compare', () => {
  it('parses a list, refuses empties, repeats, non-ids, a bare flag, and any other flag alongside it', () => {
    expect(parseReportArgs(['--compare', '14, 15,16'])).toEqual({ id: 0, day: undefined, csvDir: undefined, compare: [14, 15, 16] });
    expect(parseCompareList('3')).toEqual([3]);
    expect(() => parseCompareList('3,,4')).toThrow(/needs run ids/);
    expect(() => parseCompareList('3,x')).toThrow(/needs run ids/);
    expect(() => parseCompareList('3,4,3')).toThrow(/listed more than once/);
    // Final review, IMPORTANT 1: the same shape defect fixed in the dashboard's `parseCompareIds` —
    // `!Number.isInteger(n)` accepted `1e21` (a finite integer-valued float, reaches Postgres as an
    // out-of-range bigint) and `0x10` (silently `Number('0x10') === 16`, a DIFFERENT valid run id).
    expect(() => parseCompareList('1e21')).toThrow(/needs run ids/);
    expect(() => parseCompareList('0x10')).toThrow(/needs run ids/);
    expect(() => parseCompareList('+1')).toThrow(/needs run ids/);
    expect(() => parseCompareList('1.0')).toThrow(/needs run ids/);
    expect(() => parseReportArgs(['--compare'])).toThrow(/--compare needs a value/);
    expect(() => parseReportArgs(['--compare', '--day'])).toThrow(/--compare needs a value/);
    expect(() => parseReportArgs(['--compare', '1,2', '--csv', 'x'])).toThrow(/takes no other flags/);
    expect(() => parseReportArgs(['12', '--compare', '1,2'])).toThrow(/stands alone/);
    expect(parseReportArgs(['12']).compare).toBeUndefined();
  });
});
