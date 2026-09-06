import type { RunRow } from '@ctb/engine';
import { describe, expect, it, vi } from 'vitest';
import { adaStr, coverageLine, printReport } from '../src/commands/report.js';

/**
 * Finding M10: `adaStr` went through `Number(BigInt(x)) / 1e6`, which stops being exact above 2^53
 * lovelace (~9.007 billion ADA) and, well before that, prints an approximation of a figure the whole
 * report exists to make exact. Integer part and six fractional digits, in bigint.
 */
describe('adaStr', () => {
  it('formats whole and fractional lovelace exactly', () => {
    expect(adaStr(0n)).toBe('0.000000');
    expect(adaStr(1n)).toBe('0.000001');
    expect(adaStr(2_200_000n)).toBe('2.200000');
    expect(adaStr('1000000000')).toBe('1000.000000');
    expect(adaStr(999_999n)).toBe('0.999999');
  });

  it('stays exact past 2^53 lovelace, where the float path silently rounded', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1: Number() cannot represent this
    expect(adaStr(big)).toBe('9007199254.740993');
    expect(adaStr(big)).not.toBe((Number(big) / 1_000_000).toFixed(6));
  });

  it('keeps the sign on a negative balance', () => {
    expect(adaStr(-2_200_000n)).toBe('-2.200000');
    expect(adaStr(-1n)).toBe('-0.000001');
  });
});

/** Finding C3: the coverage header is where a sparse window stops being invisible. */
describe('coverageLine', () => {
  it('states how much of the window the run actually saw', () => {
    const line = coverageLine({ candles: 4400, first: '2026-06-01T00:00:00.000Z', last: '2026-09-01T00:00:00.000Z', expectedBuckets: 26_496, maxGapMs: 26_700_000, gapsOverBound: 561 });
    expect(line).toContain('4400 of 26496 expected buckets (16.6%)');
    expect(line).toContain('max gap 445m');
    expect(line).toContain('561 gaps over the stale-fill bound');
  });

  it('says so rather than dividing by zero on an empty window', () => {
    expect(coverageLine({ candles: 0, first: null, last: null, expectedBuckets: 0, maxGapMs: 0, gapsOverBound: 0 })).toContain('empty window');
  });

  it('names a run that predates coverage instead of printing blanks', () => {
    expect(coverageLine(undefined)).toMatch(/not recorded/);
  });
});

/**
 * Finding F3: the ad-hoc `console.log('REHEARSAL')` in `paper.ts` only fired on the freshly-run
 * process's own exit; `report <run-id>` — a separate process reading the same run later — printed no
 * such warning at all, so a rehearsal run's numbers looked exactly like a real run's the moment
 * anyone re-ran the report. The header must come from the run ROW (`run.rehearsal`), so every path
 * that prints a report gets it, not just the process that happened to create the run.
 */
describe('printReport REHEARSAL header', () => {
  const baseRun: RunRow = {
    id: 1, mode: 'paper', strategyId: 'ma-crossover', params: {}, gitSha: 'abc123', baseUnit: 'lovelace.TOKEN',
    dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: new Date('2026-01-01T00:00:00Z'), dataTo: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'), finishedAt: null, summary: null,
    status: 'finished', heartbeatAt: null, lastTickTs: null, stopReason: null, rehearsal: false,
  };

  it('prints REHEARSAL as the first line when the run row says rehearsal: true', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printReport({ ...baseRun, rehearsal: true }, [], 'TOKEN');
      expect(log.mock.calls[0]?.[0]).toMatch(/^REHEARSAL/);
    } finally {
      log.mockRestore();
    }
  });

  it('does not print a REHEARSAL line when the run row says rehearsal: false', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printReport({ ...baseRun, rehearsal: false }, [], 'TOKEN');
      expect(log.mock.calls[0]?.[0]).not.toMatch(/^REHEARSAL/);
      expect(log.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/REHEARSAL/);
    } finally {
      log.mockRestore();
    }
  });
});
