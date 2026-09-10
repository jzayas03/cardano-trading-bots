import type { EquityPoint, OrderRecord, RunRow } from '@ctb/engine';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { dayWindow, printDayReport, printReport, reportCommand, summarizeDay } from '../src/commands/report.js';

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
    // Split by side and never summed: the pool's cut is charged on the order's INPUT, so a buy's is
    // lovelace and a sell's is token subunits. Only the buy filled here.
    expect(s.poolFeesInLovelace).toBe(1_500_000n);
    expect(s.poolFeesInBase).toBe(0n);
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
    expect(s.poolFeesInLovelace).toBe(0n);
    expect(s.poolFeesInBase).toBe(0n);
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

/**
 * Review finding (Task 5, round 1): `report --day` omitted the assumed-venue warning that the
 * non-`--day` `printReport` already prints — a `--day` reader had no way to know a day's fills
 * touched a venue whose batcher/network fee is `assumed` rather than read from documentation
 * (`assumedVenuesTouched`, `packages/sim-executor/src/costs.ts`). `Splash` is `basis: 'assumed'`;
 * `Minswap` is `basis: 'documented'` — same fixture shape the non-`--day` path already relies on.
 */
describe('printDayReport assumed-venue warning', () => {
  const dayRun: RunRow = {
    id: 9, mode: 'paper', strategyId: 'ma-crossover', params: {}, gitSha: 'abc123', baseUnit: 'lovelace.TOKEN',
    dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: new Date('2026-06-15T00:00:00Z'), dataTo: new Date('2026-06-15T00:00:00Z'),
    createdAt: new Date('2026-06-15T00:00:00Z'), finishedAt: null, summary: null,
    status: 'running', heartbeatAt: null, lastTickTs: null, stopReason: null, rehearsal: false,
  };
  const { from, to } = dayWindow('2026-06-15');

  const filledOn = (poolId: string): OrderRecord & { baseUnit: string } => ({
    seq: 1,
    tsIntent: new Date('2026-06-15T05:00:00.000Z'),
    intent: { side: 'buy', amountIn: 500_000_000n, reason: 'signal' },
    result: {
      status: 'filled', poolId, unitIn: 'lovelace', amountIn: 500_000_000n, unitOut: 'lovelace.TOKEN', amountOut: 400_000_000n,
      midPrice: '1.0', fillPrice: '1.01', poolFeeIn: 1_500_000n, batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n,
      slippageBps: 10, priceImpactBps: 5, poolAfter: null, tsFill: new Date('2026-06-15T05:00:01.000Z'),
    },
    baseUnit: 'lovelace.TOKEN',
  });

  it('prints the warning when a filled order in the day touched an assumed venue', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printDayReport(dayRun, 'TOKEN', from, to, [], [filledOn('Splash:x')], new Date());
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContainEqual(expect.stringContaining('ASSUMED costs: Splash'));
    } finally {
      log.mockRestore();
    }
  });

  it('does not print the warning when the day only touched a documented venue', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printDayReport(dayRun, 'TOKEN', from, to, [], [filledOn('Minswap:x')], new Date());
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('ASSUMED costs'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

/**
 * Review finding (Task 5, round 1): `report <id> --day` with `--day` as the LAST argument (no value
 * following it) silently fell through to the non-`--day` path instead of failing — `dayArg` stayed
 * `undefined` so `window` was computed as `null`, and the command proceeded as if `--day` had never
 * been passed. An operator who fat-fingers the flag gets the wrong report silently rather than a
 * usage error.
 */
describe('reportCommand --day requires a value', () => {
  const noopLog = { error: () => {} } as unknown as Logger;

  it('throws a usage error rather than falling through to the non-day report', async () => {
    await expect(reportCommand(noopLog, ['5', '--day'])).rejects.toThrow(/usage: report <run-id>/);
  });
});

/**
 * Findings I3 and I4. I3: the `--day` header named the run, mode, strategy, ticker and day but NOT
 * the commit that produced the numbers, while spec §8 M3 requires the daily report to cite the git
 * sha — the non-day report already did, so a reader who only ever saw `--day` output could not tell
 * which code a day's fills came from. I4: the feed counters persisted on the run row are only worth
 * persisting if a report prints them; a day of `yielded 0` with a climbing `emptyBoundaries` is what
 * a dead collector looks like from inside the paper process.
 */
describe('report headers cite provenance and feed health (findings I3, I4)', () => {
  const withCounters = (counters: unknown): RunRow => ({
    id: 11, mode: 'paper', strategyId: 'ma-crossover', params: { feedCounters: counters }, gitSha: 'deadbeefcafe',
    baseUnit: 'lovelace.TOKEN', dataSource: 'candles', fillModel: 'cpmm_observed',
    dataFrom: new Date('2026-06-15T00:00:00Z'), dataTo: new Date('2026-06-15T00:00:00Z'),
    createdAt: new Date('2026-06-15T00:00:00Z'), finishedAt: null, summary: null,
    status: 'running', heartbeatAt: new Date('2026-06-15T09:05:00.000Z'), lastTickTs: null, stopReason: null, rehearsal: false,
  });
  const { from, to } = dayWindow('2026-06-15');
  const counters = { ticks: 288, built: 280, yielded: 275, skippedStale: 3, emptyBoundaries: 5, tickFailures: 2 };

  const linesFrom = (fn: () => void): string[] => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    try {
      fn();
      return log.mock.calls.map((c) => String(c[0]));
    } finally {
      table.mockRestore();
      log.mockRestore();
    }
  };

  it('prints the git sha in the --day header (finding I3)', () => {
    const lines = linesFrom(() => printDayReport(withCounters(counters), 'TOKEN', from, to, [], [], new Date()));
    expect(lines[0]).toContain('git deadbeefcafe');
  });

  it('prints the feed counters in the --day report (finding I4)', () => {
    const lines = linesFrom(() => printDayReport(withCounters(counters), 'TOKEN', from, to, [], [], new Date()));
    const feed = lines.find((l) => l.startsWith('feed:'));
    expect(feed).toBeDefined();
    expect(feed).toContain('288 ticks');
    expect(feed).toContain('275 yielded');
    expect(feed).toContain('5 empty');
    expect(feed).toContain('2 failed');
  });

  it('prints the feed counters in the non-day paper report too', () => {
    const lines = linesFrom(() => printReport(withCounters(counters), [], 'TOKEN'));
    expect(lines.some((l) => l.startsWith('feed:') && l.includes('288 ticks'))).toBe(true);
  });

  it('says the counters were not recorded rather than printing zeros for a run that predates them', () => {
    const lines = linesFrom(() => printReport(withCounters(undefined), [], 'TOKEN'));
    const feed = lines.find((l) => l.startsWith('feed:'));
    expect(feed).toMatch(/not recorded/);
  });

  it('is not fooled by a non-object feedCounters value', () => {
    const lines = linesFrom(() => printReport(withCounters('nonsense'), [], 'TOKEN'));
    expect(lines.find((l) => l.startsWith('feed:'))).toMatch(/not recorded/);
  });

  it('prints no feed line for a backtest run, which has no feed', () => {
    const lines = linesFrom(() => printReport({ ...withCounters(counters), mode: 'backtest' }, [], 'TOKEN'));
    expect(lines.some((l) => l.startsWith('feed:'))).toBe(false);
  });
});

/**
 * Finding M2: `reportCommand` looped over its arguments looking only for `--day` and ignored
 * everything else, so `report 6 --dya 2026-09-06`, `report 6 --rehearsal`, or a stray shell word
 * produced a confident full-run report while silently discarding what the operator asked for. Every
 * other command in this CLI rejects an unknown flag; this one did not.
 */
describe('reportCommand rejects unknown arguments (finding M2)', () => {
  const noopLog = { error: () => {} } as unknown as Logger;

  it('rejects a misspelled flag rather than reporting something else', async () => {
    await expect(reportCommand(noopLog, ['5', '--dya', '2026-09-06'])).rejects.toThrow(/unknown argument --dya/);
  });

  it('rejects a stray positional argument', async () => {
    await expect(reportCommand(noopLog, ['5', '2026-09-06'])).rejects.toThrow(/unknown argument 2026-09-06/);
  });

  it('rejects a flag that belongs to another command', async () => {
    await expect(reportCommand(noopLog, ['5', '--rehearsal'])).rejects.toThrow(/unknown argument --rehearsal/);
  });

  it('still rejects a run id that is not a positive integer', async () => {
    await expect(reportCommand(noopLog, ['0'])).rejects.toThrow(/usage: report <run-id>/);
    await expect(reportCommand(noopLog, ['abc'])).rejects.toThrow(/usage: report <run-id>/);
  });
});
