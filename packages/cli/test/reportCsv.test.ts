import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrderRecord, RunRow } from '@ctb/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReportArgs, writeCsvExport } from '../src/commands/report.js';

const run = (over: Partial<RunRow>): RunRow => ({
  id: 12, mode: 'backtest', strategyId: 'rsi-mean-reversion', gitSha: 'abc', baseUnit: 'u', dataSource: 'candles_external', fillModel: 'cpmm_synthetic_depth',
  dataFrom: new Date(0), dataTo: new Date(1), params: {}, createdAt: new Date(0), finishedAt: null, summary: null, status: 'finished', heartbeatAt: null, lastTickTs: null, stopReason: null, rehearsal: false,
  ...over,
} as RunRow);
const order: OrderRecord = { seq: 1, tsIntent: new Date(0), intent: { side: 'buy', amountIn: 1n, reason: 'x' }, result: { status: 'rejected', reason: 'dust' } };

describe('parseReportArgs', () => {
  it('parses --csv with a directory and keeps --day working', () => {
    expect(parseReportArgs(['12', '--csv', 'out'])).toEqual({ id: 12, day: undefined, csvDir: 'out', compare: undefined });
    expect(parseReportArgs(['12', '--day', '2026-09-06'])).toEqual({ id: 12, day: '2026-09-06', csvDir: undefined, compare: undefined });
  });
  it('refuses a bare --csv, a flag where the value should be, --csv with --day, and unknown flags', () => {
    expect(() => parseReportArgs(['12', '--csv'])).toThrow(/--csv needs a value/);
    expect(() => parseReportArgs(['12', '--csv', '--day', '2026-09-06'])).toThrow(/--csv needs a value/);
    expect(() => parseReportArgs(['12', '--day', '2026-09-06', '--csv', 'out'])).toThrow(/does not combine/);
    expect(() => parseReportArgs(['12', '--dya', 'x'])).toThrow(/unknown argument --dya/);
    expect(() => parseReportArgs(['zero'])).toThrow(/usage/);
  });
});

describe('writeCsvExport', () => {
  const dirs: string[] = [];
  const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), 'ctb-csv-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('writes orders only for a backtest and orders plus equity for a paper run, creating the directory', () => {
    const dir = join(fresh(), 'nested');
    expect(writeCsvExport(dir, run({}), [order], [])).toEqual([join(dir, 'run-12-orders.csv')]);
    expect(existsSync(join(dir, 'run-12-equity.csv'))).toBe(false);
    const paper = writeCsvExport(dir, run({ id: 13, mode: 'paper' }), [order], [{ tickTs: new Date(0), cashLovelace: 1n, positionBase: 0n, equityLovelace: 1n, equityExecutableLovelace: null, price: '1' }]);
    expect(paper).toEqual([join(dir, 'run-13-orders.csv'), join(dir, 'run-13-equity.csv')]);
    expect(readFileSync(join(dir, 'run-13-equity.csv'), 'utf8').split('\n')).toHaveLength(3);
  });
  it('names a rehearsal run\'s files REHEARSAL', () => {
    const dir = fresh();
    expect(writeCsvExport(dir, run({ id: 7, mode: 'paper', rehearsal: true }), [], [])).toEqual([join(dir, 'run-7-REHEARSAL-orders.csv'), join(dir, 'run-7-REHEARSAL-equity.csv')]);
  });
  it('never overwrites: a second export onto the same directory is refused and names the file', () => {
    const dir = fresh();
    writeCsvExport(dir, run({}), [order], []);
    const before = readFileSync(join(dir, 'run-12-orders.csv'), 'utf8');
    expect(() => writeCsvExport(dir, run({}), [], [])).toThrow(/run-12-orders\.csv already exists; move it aside/);
    expect(readFileSync(join(dir, 'run-12-orders.csv'), 'utf8')).toBe(before);
  });
});
