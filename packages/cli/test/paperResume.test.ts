import type { CandleRepo, CandleRow, SnapshotForCandle } from '@ctb/candles';
import { describe, expect, it } from 'vitest';
import { readPrimeHistory } from '../src/commands/paper.js';

const UNIT = 'testunit';
const t = (m: number): Date => new Date(Date.UTC(2026, 8, 6, 12, m));

const row = (m: number): CandleRow => ({
  baseUnit: UNIT, tickTs: t(m), poolId: 'pool1', open: '1.0', high: '1.1', low: '0.9', close: `${1 + m / 100}`,
  closeReserveBase: 1_000n, closeReserveQuote: 1_000n, feeBps: 30, poolType: 'cpmm', tvlLovelace: 2_000n,
  netFlowBase: null, netFlowQuote: null,
});

/** Records the window it was asked for; returns the seeded rows that fall inside it. */
class RecordingRepo implements CandleRepo {
  calls: Array<{ baseUnit: string; from: Date; to: Date }> = [];
  constructor(private readonly rows: CandleRow[]) {}
  async readSnapshotsSince(): Promise<SnapshotForCandle[]> { return []; }
  async lastCandle(): Promise<null> { return null; }
  async insertCandles(): Promise<number> { return 0; }
  async readCandles(baseUnit: string, from: Date, to: Date): Promise<CandleRow[]> {
    this.calls.push({ baseUnit, from, to });
    return this.rows.filter((r) => r.tickTs >= from && r.tickTs <= to);
  }
  async transaction<T>(fn: (repo: CandleRepo) => Promise<T>): Promise<T> { return fn(this); }
}

/**
 * Finding I6: the resume path's half of `primeHistory`. The engine-side behaviour (a primed window
 * lets the first live candle decide) is pinned in `loop.test.ts`; this pins the read that fills it.
 */
describe('readPrimeHistory', () => {
  it('returns the last `warmup` candles at or before afterTick, oldest first', async () => {
    const repo = new RecordingRepo(Array.from({ length: 20 }, (_, i) => row(i)));
    const primed = await readPrimeHistory(repo, UNIT, t(10), 3, 60);
    expect(primed.map((c) => c.tickTs.toISOString())).toEqual([t(8).toISOString(), t(9).toISOString(), t(10).toISOString()]);
  });

  it('never reads past afterTick: a candle after the resume point is not context, it is the future', async () => {
    const repo = new RecordingRepo(Array.from({ length: 20 }, (_, i) => row(i)));
    await readPrimeHistory(repo, UNIT, t(10), 3, 60);
    expect(repo.calls[0]?.to).toEqual(t(10));
    // The window reaches back warmup * intervalSec * 2 seconds so a sparse stretch can still fill it.
    expect(repo.calls[0]?.from).toEqual(new Date(t(10).getTime() - 3 * 60 * 1000 * 2));
    expect(repo.calls[0]?.baseUnit).toBe(UNIT);
  });

  it('primes with fewer than warmup when that is all the history there is, rather than failing', async () => {
    const repo = new RecordingRepo([row(9), row(10)]);
    const primed = await readPrimeHistory(repo, UNIT, t(10), 5, 60);
    expect(primed).toHaveLength(2);
  });

  it('reads nothing at all for a zero warmup', async () => {
    const repo = new RecordingRepo([row(10)]);
    expect(await readPrimeHistory(repo, UNIT, t(10), 0, 60)).toEqual([]);
    expect(repo.calls).toEqual([]);
  });

  it('carries the persisted candle through unchanged, with volumeQuote null', async () => {
    const repo = new RecordingRepo([row(10)]);
    const [primed] = await readPrimeHistory(repo, UNIT, t(10), 1, 60);
    expect(primed).toEqual({
      tickTs: t(10), open: '1.0', high: '1.1', low: '0.9', close: '1.1', volumeQuote: null,
      poolId: 'pool1', poolType: 'cpmm', feeBps: 30, closeReserveBase: 1_000n, closeReserveQuote: 1_000n, tvlLovelace: 2_000n,
    });
  });
});
