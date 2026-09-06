import { describe, expect, it, vi } from 'vitest';
import type { CandleRepo } from '@ctb/candles';
import type { CandleRow, SnapshotForCandle } from '@ctb/candles';
import type { Candle } from '@ctb/engine';
import type { TokenSpec } from '@ctb/universe';
import { liveCandleFeed, type FeedTickInfo } from '../src/liveFeed.js';

const TOKEN: Pick<TokenSpec, 'unit' | 'decimals' | 'ticker'> = { unit: 'testunit', decimals: 6, ticker: 'TEST' };

/** Mutable fake clock: `advance` moves it forward the way a real sleep would, without a real timer. */
function makeClock(startIso: string): { now: () => Date; advance: (ms: number) => void } {
  let ms = new Date(startIso).getTime();
  return { now: () => new Date(ms), advance: (d: number) => { ms += d; } };
}

/**
 * In-memory `CandleRepo`. `transaction(fn)` runs `fn(this)` (no real transaction), matching the
 * controller ruling for this test suite. Tests seed `candles` directly by tickTs; `readSnapshotsSince`
 * always returns empty, so `buildCandlesForToken` never manufactures extra rows from snapshots — the
 * only candles a test sees are the ones it seeded.
 */
class FakeCandleRepo implements CandleRepo {
  candles: CandleRow[] = [];
  readCandlesCalls: Array<{ from: Date; to: Date }> = [];
  failReadCandlesOnce = false;
  /** Fail the next N `readCandles` calls, for testing a failure STREAK rather than one blip. */
  failReadCandlesTimes = 0;

  async readSnapshotsSince(): Promise<SnapshotForCandle[]> {
    return [];
  }

  async lastCandle(): Promise<null> {
    return null;
  }

  async insertCandles(rows: CandleRow[]): Promise<number> {
    this.candles.push(...rows);
    return rows.length;
  }

  async readCandles(baseUnit: string, from: Date, to: Date): Promise<CandleRow[]> {
    this.readCandlesCalls.push({ from, to });
    if (this.failReadCandlesOnce) {
      this.failReadCandlesOnce = false;
      throw new Error('read candles failed');
    }
    if (this.failReadCandlesTimes > 0) {
      this.failReadCandlesTimes--;
      throw new Error('read candles failed');
    }
    return this.candles
      .filter((c) => c.baseUnit === baseUnit && c.tickTs.getTime() >= from.getTime() && c.tickTs.getTime() <= to.getTime())
      .sort((a, b) => a.tickTs.getTime() - b.tickTs.getTime());
  }

  async transaction<T>(fn: (repo: CandleRepo) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function mkCandleRow(tickTs: Date, overrides: Partial<CandleRow> = {}): CandleRow {
  return {
    baseUnit: TOKEN.unit, tickTs, poolId: 'pool1', open: '1.0', high: '1.0', low: '1.0', close: '1.0',
    closeReserveBase: 1000n, closeReserveQuote: 1000n, feeBps: 30, poolType: 'cpmm', tvlLovelace: 2000n,
    netFlowBase: null, netFlowQuote: null, ...overrides,
  };
}

function makeLog(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Records every `ms` argument, advances the fake clock, and aborts `ac` on the Nth call (1-indexed) if given. */
function makeFakeSleep(clock: ReturnType<typeof makeClock>, calls: number[], ac: AbortController, abortOnCall?: number) {
  let count = 0;
  return async (ms: number): Promise<void> => {
    count++;
    calls.push(ms);
    clock.advance(ms);
    if (abortOnCall === count) ac.abort();
  };
}

async function collect(feed: AsyncIterable<Candle>): Promise<Candle[]> {
  const out: Candle[] = [];
  for await (const c of feed) out.push(c);
  return out;
}

describe('liveCandleFeed', () => {
  it('sleeps to boundary + grace: 12:07:41 with interval 300 and grace 60 sleeps 139000 + 60000 ms to 12:11:00', async () => {
    const clock = makeClock('2026-09-05T12:07:41.000Z');
    const ac = new AbortController();
    const sleepCalls: number[] = [];
    const sleep = makeFakeSleep(clock, sleepCalls, ac, 1); // abort right after the first sleep resolves
    const repo = new FakeCandleRepo();
    const log = makeLog();
    const feed = liveCandleFeed({
      repo, token: TOKEN, intervalSec: 300, graceSec: 60, maxGapMs: 15 * 60_000,
      now: clock.now, sleep, signal: ac.signal, log,
    });
    await collect(feed);
    expect(sleepCalls).toEqual([139_000 + 60_000]);
    expect(clock.now().toISOString()).toBe('2026-09-05T12:11:00.000Z');
  });

  it('yields new candles <= boundary in order, never re-yields, and respects afterTick', async () => {
    const clock = makeClock('2026-09-05T12:05:00.000Z'); // boundary-aligned
    const ac = new AbortController();
    const sleepCalls: number[] = [];
    const sleep = makeFakeSleep(clock, sleepCalls, ac, 3); // let cycles 1 and 2 run, then stop before cycle 3's build
    const repo = new FakeCandleRepo();
    const log = makeLog();
    const beforeAfterTick = mkCandleRow(new Date('2026-09-05T12:00:00.000Z')); // strictly before afterTick: must never surface
    const c1 = mkCandleRow(new Date('2026-09-05T12:04:00.000Z')); // cycle 1 window (12:02:00.001 .. 12:10:00]
    const c2 = mkCandleRow(new Date('2026-09-05T12:09:00.000Z')); // cycle 1 window, after c1
    const c3 = mkCandleRow(new Date('2026-09-05T12:13:00.000Z')); // cycle 2 window (12:09:00.001 .. 12:15:00]
    repo.candles.push(beforeAfterTick, c1, c2, c3);
    const feed = liveCandleFeed({
      repo, token: TOKEN, intervalSec: 300, graceSec: 60, maxGapMs: 20 * 60_000,
      now: clock.now, sleep, signal: ac.signal, log, afterTick: new Date('2026-09-05T12:02:00.000Z'),
    });
    const out = await collect(feed);
    expect(out.map((c) => c.tickTs.toISOString())).toEqual([
      '2026-09-05T12:04:00.000Z', '2026-09-05T12:09:00.000Z', '2026-09-05T12:13:00.000Z',
    ]);
    // afterTick excludes the earlier candle entirely.
    expect(out.some((c) => c.tickTs.getTime() === beforeAfterTick.tickTs.getTime())).toBe(false);
    // Consecutive reads never overlap: each `from` moves past what was already yielded, so nothing is re-read/re-yielded.
    expect(repo.readCandlesCalls.map((c) => c.from.toISOString())).toEqual([
      '2026-09-05T12:02:00.001Z', // afterTick + 1ms
      '2026-09-05T12:09:00.001Z', // lastYielded (c2) + 1ms
    ]);
  });

  it('skips a candle older than maxGapMs at arrival, counts it, and reports { built, yielded, skippedStale } via onTick', async () => {
    const clock = makeClock('2026-09-05T12:05:00.000Z');
    const ac = new AbortController();
    const sleepCalls: number[] = [];
    const sleep = makeFakeSleep(clock, sleepCalls, ac, 2); // stop right after cycle 1's onTick
    const repo = new FakeCandleRepo();
    const log = makeLog();
    const stale = mkCandleRow(new Date('2026-09-05T12:07:00.000Z')); // age at check (12:11:00) = 240s > 120s maxGapMs
    const fresh = mkCandleRow(new Date('2026-09-05T12:10:00.000Z')); // age at check = 60s <= 120s maxGapMs
    repo.candles.push(stale, fresh);
    const onTick = vi.fn(async () => undefined);
    const feed = liveCandleFeed({
      repo, token: TOKEN, intervalSec: 300, graceSec: 60, maxGapMs: 120_000,
      now: clock.now, sleep, signal: ac.signal, log, onTick,
    });
    const out = await collect(feed);
    expect(out.map((c) => c.tickTs.toISOString())).toEqual(['2026-09-05T12:10:00.000Z']);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ tickTs: stale.tickTs }), 'stale candle skipped');
    expect(onTick).toHaveBeenCalledTimes(1);
    // The tick report grew `failed`/`emptyBoundary`/`consecutiveFailures`/`lastError` with findings
    // I4 and I5 — the counters are now persisted and the streak drives an abort, so a clean tick has
    // to say so explicitly rather than by the absence of a field.
    expect(onTick).toHaveBeenCalledWith({
      boundary: new Date('2026-09-05T12:10:00.000Z'), built: 0, yielded: 1, skippedStale: 1,
      failed: false, emptyBoundary: false, consecutiveFailures: 0, lastError: null,
    });
  });

  it('logs a repository error at one boundary and continues to the next boundary', async () => {
    const clock = makeClock('2026-09-05T12:05:00.000Z');
    const ac = new AbortController();
    const sleepCalls: number[] = [];
    const sleep = makeFakeSleep(clock, sleepCalls, ac, 3); // cycle 1 fails, cycle 2 succeeds, stop before cycle 3
    const repo = new FakeCandleRepo();
    repo.failReadCandlesOnce = true; // cycle 1's readCandles throws once
    const log = makeLog();
    const c2 = mkCandleRow(new Date('2026-09-05T12:13:00.000Z')); // lands inside cycle 2's window
    repo.candles.push(c2);
    const onTick = vi.fn(async () => undefined);
    const feed = liveCandleFeed({
      repo, token: TOKEN, intervalSec: 300, graceSec: 60, maxGapMs: 20 * 60_000,
      now: clock.now, sleep, signal: ac.signal, log, onTick,
    });
    const out = await collect(feed);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[1]).toBe('live feed tick failed; continuing');
    // The failed cycle still reports a tick (all zero) so the run's heartbeat keeps moving — and now
    // names the failure and the streak, which is what lets the caller stop a permanently broken run.
    expect(onTick).toHaveBeenNthCalledWith(1, {
      boundary: new Date('2026-09-05T12:10:00.000Z'), built: 0, yielded: 0, skippedStale: 0,
      failed: true, emptyBoundary: false, consecutiveFailures: 1, lastError: 'read candles failed',
    });
    expect(out.map((c) => c.tickTs.toISOString())).toEqual(['2026-09-05T12:13:00.000Z']);
  });

  it('ends the iteration without yielding further when aborted during sleep', async () => {
    const clock = makeClock('2026-09-05T12:05:00.000Z');
    const ac = new AbortController();
    const sleepCalls: number[] = [];
    const sleep = makeFakeSleep(clock, sleepCalls, ac, 1); // abort during/right after the very first sleep
    const repo = new FakeCandleRepo();
    const log = makeLog();
    // A candle that WOULD be yielded if the loop ever reached the build/read step.
    repo.candles.push(mkCandleRow(new Date('2026-09-05T12:10:00.000Z')));
    const feed = liveCandleFeed({
      repo, token: TOKEN, intervalSec: 300, graceSec: 60, maxGapMs: 20 * 60_000,
      now: clock.now, sleep, signal: ac.signal, log,
    });
    const out = await collect(feed);
    expect(out).toEqual([]);
    expect(repo.readCandlesCalls).toEqual([]);
  });
});

/**
 * Findings I1(a), I4 and I5. Three defects in one code path:
 *
 * I1(a): `await d.onTick(...)` sat OUTSIDE the feed's try, so a transient failure writing the
 * heartbeat threw out of the generator, through the engine's `for await`, into `paperCommand`'s
 * catch — a five-second Postgres blip ended a seven-day run. It belongs inside the try, counted like
 * any other tick failure.
 *
 * I4: `built`/`yielded`/`skippedStale` were reported to `onTick` and then dropped on the floor. A
 * run that stopped seeing candles at 03:00 looked identical, in every persisted artefact, to one
 * that ran clean — so the counters are now accumulated and persisted.
 *
 * I5: the feed swallowed every error and looped forever. A paper run whose database or candle
 * builder was permanently broken kept heartbeating, kept reporting `status = 'running'`, and never
 * traded again. The feed now counts CONSECUTIVE failures (reset by any clean tick) and reports the
 * streak, so the command can stop a run that is failing rather than merely slow.
 */
describe('liveCandleFeed tick reporting, counters, and failure streaks', () => {
  it('reports a clean tick with failed false, a zero streak, and no error', async () => {
    const clock = makeClock('2026-09-05T12:05:00.000Z');
    const ac = new AbortController();
    const sleep = makeFakeSleep(clock, [], ac, 2);
    const repo = new FakeCandleRepo();
    repo.candles.push(mkCandleRow(new Date('2026-09-05T12:10:00.000Z')));
    const onTick = vi.fn(async (_info: FeedTickInfo) => undefined);
    await collect(liveCandleFeed({
      repo, token: TOKEN, intervalSec: 300, graceSec: 60, maxGapMs: 20 * 60_000,
      now: clock.now, sleep, signal: ac.signal, log: makeLog(), onTick,
    }));
    expect(onTick).toHaveBeenCalledWith({
      boundary: new Date('2026-09-05T12:10:00.000Z'), built: 0, yielded: 1, skippedStale: 0,
      failed: false, emptyBoundary: false, consecutiveFailures: 0, lastError: null,
    });
  });

  it('does not kill the run when onTick itself throws: it counts as this boundary failing (finding I1a)', async () => {
    const clock = makeClock('2026-09-05T12:05:00.000Z');
    const ac = new AbortController();
    const sleep = makeFakeSleep(clock, [], ac, 3);
    const repo = new FakeCandleRepo();
    repo.candles.push(mkCandleRow(new Date('2026-09-05T12:10:00.000Z')), mkCandleRow(new Date('2026-09-05T12:13:00.000Z')));
    const log = makeLog();
    let calls = 0;
    const onTick = vi.fn(async (_info: FeedTickInfo) => {
      calls++;
      if (calls === 1) throw new Error('heartbeat write failed');
    });
    // The generator must not reject; the second boundary must still be reached and reported.
    const out = await collect(liveCandleFeed({
      repo, token: TOKEN, intervalSec: 300, graceSec: 60, maxGapMs: 20 * 60_000,
      now: clock.now, sleep, signal: ac.signal, log, onTick,
    }));
    expect(out.map((c) => c.tickTs.toISOString())).toEqual(['2026-09-05T12:10:00.000Z', '2026-09-05T12:13:00.000Z']);
    expect(log.error).toHaveBeenCalled();
    const failing = onTick.mock.calls.map((c) => c[0]);
    expect(failing.some((i) => i.failed && i.lastError === 'heartbeat write failed'), 'the failed boundary is reported, not swallowed').toBe(true);
  });

  it('counts consecutive failures and resets the streak on the first clean tick (finding I5)', async () => {
    const clock = makeClock('2026-09-05T12:05:00.000Z');
    const ac = new AbortController();
    const sleep = makeFakeSleep(clock, [], ac, 4); // three boundaries, then stop
    const repo = new FakeCandleRepo();
    repo.failReadCandlesTimes = 2; // boundaries 1 and 2 fail, boundary 3 succeeds
    repo.candles.push(mkCandleRow(new Date('2026-09-05T12:18:00.000Z')));
    const onTick = vi.fn(async (_info: FeedTickInfo) => undefined);
    await collect(liveCandleFeed({
      repo, token: TOKEN, intervalSec: 300, graceSec: 60, maxGapMs: 40 * 60_000,
      now: clock.now, sleep, signal: ac.signal, log: makeLog(), onTick,
    }));
    const streaks = onTick.mock.calls.map((c) => (c[0] as { consecutiveFailures: number }).consecutiveFailures);
    expect(streaks).toEqual([1, 2, 0]);
  });

  it('carries the failing boundary error message so the caller can name it in a stop reason', async () => {
    const clock = makeClock('2026-09-05T12:05:00.000Z');
    const ac = new AbortController();
    const sleep = makeFakeSleep(clock, [], ac, 2);
    const repo = new FakeCandleRepo();
    repo.failReadCandlesTimes = 1;
    const onTick = vi.fn(async (_info: FeedTickInfo) => undefined);
    await collect(liveCandleFeed({
      repo, token: TOKEN, intervalSec: 300, graceSec: 60, maxGapMs: 20 * 60_000,
      now: clock.now, sleep, signal: ac.signal, log: makeLog(), onTick,
    }));
    expect(onTick.mock.calls[0]?.[0]).toMatchObject({ failed: true, consecutiveFailures: 1, lastError: 'read candles failed' });
  });
});
