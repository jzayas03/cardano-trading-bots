import type { RunRow } from '@ctb/engine';
import { describe, expect, it, vi } from 'vitest';
import { adaStr, coverageLine, printReport, renderExposure } from '../src/commands/report.js';

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
    const line = coverageLine({ candles: 4400, first: '2026-06-01T00:00:00.000Z', last: '2026-09-01T00:00:00.000Z', expectedBuckets: 26_496, maxGapMs: 26_700_000, gapsOverBound: 561, distinctPools: 1 });
    expect(line).toContain('4400 of 26496 expected buckets (16.6%)');
    expect(line).toContain('max gap 445m');
    expect(line).toContain('561 gaps over the stale-fill bound');
    expect(line).toContain('1 pool');
  });

  it('says so rather than dividing by zero on an empty window', () => {
    expect(coverageLine({ candles: 0, first: null, last: null, expectedBuckets: 0, maxGapMs: 0, gapsOverBound: 0, distinctPools: 0 })).toContain('empty window');
  });

  it('names a run that predates coverage instead of printing blanks', () => {
    expect(coverageLine(undefined)).toMatch(/not recorded/);
  });

  it('pluralizes the pool count and says "not recorded" for a run that predates pool tracking', () => {
    const base = { candles: 10, first: '2026-09-06T20:00:00.000Z', last: '2026-09-07T23:00:00.000Z', expectedBuckets: 10, maxGapMs: 0, gapsOverBound: 0 };
    expect(coverageLine({ ...base, distinctPools: 2 })).toContain('2 pools');
    expect(coverageLine({ ...base, distinctPools: 1 })).toMatch(/\| 1 pool$/); // singular, not "1 pools"
    expect(coverageLine(base)).toContain('not recorded (run predates pool tracking)');
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

describe('renderExposure (specs/004 T024)', () => {
  const pt = (i: number, price: number, equity: number, position: bigint) => ({
    tickTs: new Date(Date.UTC(2026, 8, 17) + i * 15 * 60_000),
    cashLovelace: 0n, positionBase: position, equityLovelace: BigInt(equity),
    equityExecutableLovelace: null, price: price.toFixed(18),
  });
  const prices = [0.002, 0.00205, 0.00203, 0.0021, 0.00208, 0.00215, 0.00212, 0.0022];
  const equity = prices.map((p) => Math.round(1_000_000_000 * (p / prices[0]!)));

  it('labels the ADA alpha distinctly from the token-denominated return, and never sums them', () => {
    // This is where a units error would hide. The gate reports a TOKEN return; alpha is in ADA
    // against the token's ADA price. Printing them side by side unlabelled is exactly how three
    // months of USD rows once got read against an ADA cost floor and looked entirely normal.
    const lines = renderExposure(prices.map((p, i) => pt(i, p, equity[i]!, 1_000_000n)));
    const text = lines.join('\n');
    expect(text).toMatch(/ADA-denominated/);
    expect(text).toMatch(/in TOKENS and is not summed/);
    expect(text).toMatch(/alpha .* bps ADA/);
    expect(text).toMatch(/beta .*\(unitless\)/);
  });

  it('says when the window cannot distinguish alpha from zero, and shows the assumed rate', () => {
    const noisy = prices.map((p, i) => pt(i, p, Math.round(equity[i]! * (1 + ((i % 3) - 1) * 0.004)), 1_000_000n));
    const text = renderExposure(noisy).join('\n');
    expect(text).toMatch(/CANNOT distinguish alpha from zero/);
    expect(text).toMatch(/assumed 3% APR/);
  });

  it('says the measurement does not apply rather than printing an empty block', () => {
    const text = renderExposure([]).join('\n');
    expect(text).toMatch(/not measured/);
    expect(text).toMatch(/records no equity observations/);
  });
});

