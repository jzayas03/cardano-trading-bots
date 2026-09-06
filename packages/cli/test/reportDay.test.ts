import type { EquityPoint, OrderRecord, RunRow } from '@ctb/engine';
import { describe, expect, it, vi } from 'vitest';
import { dayWindow, printReport, summarizeDay } from '../src/commands/report.js';

/**
 * `dayWindow` turns an operator-supplied `--day YYYY-MM-DD` into the UTC window a `BETWEEN` query
 * needs: `to` is the last millisecond of that day so the window is inclusive of every tick on the day
 * and exclusive of the next day's first tick.
 */
describe('dayWindow', () => {
  it('returns the UTC day boundaries, inclusive of the last millisecond', () => {
    const { from, to } = dayWindow('2026-06-15');
    expect(from.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-15T23:59:59.999Z');
    expect(to.getTime() - from.getTime()).toBe(86_400_000 - 1);
  });

  it('is not fooled by the local timezone of the machine running it', () => {
    const { from, to } = dayWindow('2026-01-01');
    expect(from.getUTCHours()).toBe(0);
    expect(to.getUTCHours()).toBe(23);
  });

  it('rejects a day that does not exist on the calendar', () => {
    expect(() => dayWindow('2026-02-30')).toThrow();
  });

  it('rejects a day string missing zero-padding', () => {
    expect(() => dayWindow('2026-9-6')).toThrow();
  });

  it('rejects garbage input', () => {
    expect(() => dayWindow('x')).toThrow();
  });
});

/**
 * `summarizeDay` is pure: given the day's equity points and orders, it computes the return (in
 * basis points via bigint, from the first and last equity point), fill/reject counts, reject
 * reasons, the `stale t+1` sub-count, and fees. It must never touch a repo or a clock.
 */
describe('summarizeDay', () => {
  const equity: EquityPoint[] = [
    { tickTs: new Date('2026-06-15T00:05:00.000Z'), cashLovelace: 1_000_000_000n, positionBase: 0n, equityLovelace: 1_000_000_000n, equityExecutableLovelace: 999_000_000n, price: '1.0' },
    { tickTs: new Date('2026-06-15T23:55:00.000Z'), cashLovelace: 500_000_000n, positionBase: 400_000_000n, equityLovelace: 1_050_000_000n, equityExecutableLovelace: 1_040_000_000n, price: '1.05' },
  ];

  const filled: OrderRecord = {
    seq: 1,
    tsIntent: new Date('2026-06-15T05:00:00.000Z'),
    intent: { side: 'buy', amountIn: 500_000_000n, reason: 'signal' },
    result: {
      status: 'filled', poolId: 'pool1', unitIn: 'lovelace', amountIn: 500_000_000n, unitOut: 'lovelace.TOKEN', amountOut: 400_000_000n,
      midPrice: '1.0', fillPrice: '1.01', poolFeeIn: 1_500_000n, batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n,
      slippageBps: 10, priceImpactBps: 5, poolAfter: null, tsFill: new Date('2026-06-15T05:00:01.000Z'),
    },
  };
  const dustReject: OrderRecord = {
    seq: 2,
    tsIntent: new Date('2026-06-15T06:00:00.000Z'),
    intent: { side: 'sell', amountIn: 10n, reason: 'signal' },
    result: { status: 'rejected', reason: 'dust' },
  };
  const staleReject: OrderRecord = {
    seq: 3,
    tsIntent: new Date('2026-06-15T07:00:00.000Z'),
    intent: { side: 'sell', amountIn: 100_000_000n, reason: 'signal' },
    result: { status: 'rejected', reason: 'stale t+1 (gap 20m)' },
  };

  it('computes every field from two equity points and three orders', () => {
    const s = summarizeDay(equity, [filled, dustReject, staleReject]);
    expect(s.points).toBe(2);
    expect(s.startEquity).toBe(1_000_000_000n);
    expect(s.endEquity).toBe(1_050_000_000n);
    expect(s.startExecutable).toBe(999_000_000n);
    expect(s.endExecutable).toBe(1_040_000_000n);
    expect(s.returnPct).toBe(5); // (1_050_000_000 - 1_000_000_000) * 10_000n / 1_000_000_000n = 500 bps = 5.00%
    expect(s.filled).toBe(1);
    expect(s.rejected).toBe(2);
    expect(s.rejectReasons).toEqual({ dust: 1, 'stale t+1 (gap 20m)': 1 });
    expect(s.staleRejects).toBe(1);
    expect(s.feesLovelace).toBe(2_200_000n); // batcher 2_000_000 + network 200_000
    expect(s.poolFeesIn).toBe(1_500_000n);
  });

  it('returns null returnPct with fewer than two equity points', () => {
    const s = summarizeDay([equity[0]!], []);
    expect(s.points).toBe(1);
    expect(s.returnPct).toBeNull();
  });

  it('returns null returnPct rather than dividing by zero when start equity is 0', () => {
    const zeroStart: EquityPoint = { ...equity[0]!, equityLovelace: 0n };
    const s = summarizeDay([zeroStart, equity[1]!], []);
    expect(s.returnPct).toBeNull();
  });

  it('returns null start/end equity and 0 counts on an empty day', () => {
    const s = summarizeDay([], []);
    expect(s.points).toBe(0);
    expect(s.startEquity).toBeNull();
    expect(s.endEquity).toBeNull();
    expect(s.startExecutable).toBeNull();
    expect(s.endExecutable).toBeNull();
    expect(s.returnPct).toBeNull();
    expect(s.filled).toBe(0);
    expect(s.rejected).toBe(0);
    expect(s.rejectReasons).toEqual({});
    expect(s.staleRejects).toBe(0);
    expect(s.feesLovelace).toBe(0n);
    expect(s.poolFeesIn).toBe(0n);
  });
});

/**
 * Without `--day`, `printReport` for a paper run must also surface run-lifecycle fields that a
 * backtest report has no use for: `status`, `heartbeat_at`, `last_tick_ts`, `stop_reason`, and how
 * many times the run has been resumed (from `params.resumes`, appended by `RunRepo.appendResume`).
 */
describe('printReport paper-run status lines', () => {
  const baseRun: RunRow = {
    id: 7, mode: 'paper', strategyId: 'ma-crossover', params: { resumes: ['2026-06-14T00:00:00.000Z', '2026-06-15T09:00:00.000Z'] },
    gitSha: 'abc123', baseUnit: 'lovelace.TOKEN', dataSource: 'candles', fillModel: 'cpmm_observed',
    dataFrom: new Date('2026-06-01T00:00:00Z'), dataTo: new Date('2026-06-01T00:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z'), finishedAt: null, summary: null,
    status: 'running', heartbeatAt: new Date('2026-06-15T09:05:00.000Z'), lastTickTs: new Date('2026-06-15T09:00:00.000Z'),
    stopReason: null, rehearsal: false,
  };

  it('prints status, heartbeat_at, last_tick_ts, and a resumes count with the last resume time', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printReport(baseRun, [], 'TOKEN');
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContainEqual(expect.stringContaining('status: running'));
      expect(lines).toContainEqual(expect.stringContaining('heartbeat_at: 2026-06-15T09:05:00.000Z'));
      expect(lines).toContainEqual(expect.stringContaining('last_tick_ts: 2026-06-15T09:00:00.000Z'));
      expect(lines).toContainEqual(expect.stringMatching(/resumes: 2 \(last 2026-06-15T09:00:00\.000Z\)/));
    } finally {
      log.mockRestore();
    }
  });

  it('does not print any paper-run status lines for a backtest run', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printReport({ ...baseRun, mode: 'backtest' }, [], 'TOKEN');
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.startsWith('status:'))).toBe(false);
      expect(lines.some((l) => l.startsWith('resumes:'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
