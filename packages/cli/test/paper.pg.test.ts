import { PgCandleRepo, type CandleRow } from '@ctb/candles';
import { migrate, type Queryable } from '@ctb/db';
import { PgRunRepo, type Candle, type Intent, type RunRepo, type Strategy } from '@ctb/engine';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { parsePaperArgs, runPaper } from '../src/commands/paper.js';
import type { LiveFeedDeps } from '../src/liveFeed.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const TOKEN = { unit: SNEK, decimals: 0, ticker: 'SNEK' };
const t = (m: number): Date => new Date(Date.UTC(2026, 8, 6, 12, m));

/** A quiet logger with real spies, so a test can assert the retry actually warned. */
function makeLog(): Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() } as unknown as
    Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}

/** A CPMM-shaped candle the real SimExecutor can actually fill against. */
const candleAt = (m: number, reserveQuote: bigint): Candle => ({
  tickTs: t(m), open: '1.0', high: '1.0', low: '1.0', close: '1.0', volumeQuote: null,
  poolId: 'Minswap:p1', poolType: 'cpmm', feeBps: 30,
  closeReserveBase: 1_000_000_000n, closeReserveQuote: reserveQuote, tvlLovelace: 2n * reserveQuote,
});

const rowOf = (c: Candle): CandleRow => ({
  baseUnit: SNEK, tickTs: c.tickTs, poolId: c.poolId!, open: c.open, high: c.high, low: c.low, close: c.close,
  closeReserveBase: c.closeReserveBase!, closeReserveQuote: c.closeReserveQuote!, feeBps: c.feeBps!,
  poolType: 'cpmm', tvlLovelace: c.tvlLovelace!, netFlowBase: null, netFlowQuote: null,
});

/**
 * Stands in for `liveCandleFeed`: yields scripted candles at once instead of sleeping to real
 * boundaries, and reports each one through the same `onTick` contract so the counters, the heartbeat
 * and the failure-streak rule are all exercised on the real code path.
 */
function scriptedFeed(
  candles: Candle[], opts: { stopAfter?: number; ac?: AbortController; failEveryTick?: boolean } = {},
): (d: LiveFeedDeps) => AsyncIterable<Candle> {
  return (d) => ({
    async *[Symbol.asyncIterator]() {
      let n = 0;
      for (const c of candles) {
        if (d.signal.aborted) return;
        if (opts.failEveryTick) {
          n++;
          await d.onTick?.({ boundary: c.tickTs, built: 0, yielded: 0, skippedStale: 0, failed: true, emptyBoundary: false, consecutiveFailures: n, lastError: 'read candles failed' });
          continue;
        }
        yield c;
        n++;
        await d.onTick?.({ boundary: c.tickTs, built: 1, yielded: 1, skippedStale: 0, failed: false, emptyBoundary: false, consecutiveFailures: 0, lastError: null });
        if (opts.stopAfter !== undefined && n >= opts.stopAfter) opts.ac?.abort();
      }
    },
  });
}

/** Warmup 2. Buys once as soon as it has a window; sells once it holds a position. */
function testStrategy(seenHistory: number[]): Strategy {
  return {
    id: 'ma-crossover', warmup: 2, defaultParams: {}, warmupFor: () => 2,
    onCandle(ctx): Intent[] {
      seenHistory.push(ctx.history.length);
      if (ctx.portfolio.positionBase === 0n && ctx.portfolio.cashLovelace > 200_000_000n) {
        return [{ side: 'buy', amountIn: 100_000_000n, reason: 'test buy' }];
      }
      return [];
    },
  };
}

async function seedToken(db: Queryable): Promise<void> {
  await db.query(
    `INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`,
    [SNEK],
  );
}

let silence: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  silence = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'table').mockImplementation(() => {})];
  return () => { for (const s of silence) s.mockRestore(); };
});

/**
 * Finding M7: `paperCommand` was a single 100-line function that opened its own pool, installed
 * process signal handlers, and only then ran the loop — so nothing about the paper run itself could
 * be tested without a real process and a real clock. Every defect this review found in it (C1, C2,
 * I1, I5, I6) had to be found by hand-running a rehearsal. `runPaper` is that loop with its
 * dependencies handed in, and this is the end-to-end proof it persists what it claims to.
 */
describe.skipIf(!PG_ENABLED)('runPaper end to end (finding M7)', () => {
  it('persists three candles equity and orders, then stops with finished/signal on an abort', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedToken(db);
      const runs = new PgRunRepo(db);
      const candleRepo = new PgCandleRepo(db);
      const ac = new AbortController();
      const seen: number[] = [];
      const candles = [candleAt(0, 1_000_000_000n), candleAt(1, 1_010_000_000n), candleAt(2, 1_020_000_000n)];
      const log = makeLog();

      const result = await runPaper({
        db, runs, candleRepo, token: TOKEN, strategy: testStrategy(seen),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--grace-sec', '0']),
        collectIntervalSec: 60, log, now: () => t(3), sleep: async () => {}, signal: ac.signal,
        feedFactory: scriptedFeed(candles, { stopAfter: 3, ac }), gitSha: 'testsha',
      });

      const run = await runs.getRun(result.runId);
      expect(run).toMatchObject({ mode: 'paper', status: 'finished', stopReason: 'signal' });
      expect(run?.gitSha).toBe('testsha');
      // I2: with no --interval-sec, the run adopts the collector's own cadence.
      expect(run?.params.intervalSec).toBe(60);

      const equity = await runs.listEquity(result.runId, new Date(0), t(59));
      expect(equity.map((e) => e.tickTs.toISOString())).toEqual([t(0), t(1), t(2)].map((d) => d.toISOString()));

      const orders = await runs.listOrders(result.runId);
      expect(orders.length).toBeGreaterThan(0);
      expect(orders[0]?.seq).toBe(1);
      // I4: the feed counters reached the run row.
      expect(run?.params.feedCounters).toMatchObject({ ticks: 3, yielded: 3, tickFailures: 0 });
    });
  });

  it('writes each candle orders and equity in ONE transaction, and retries a transient commit failure (finding I1b)', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedToken(db);
      const runs = new PgRunRepo(db);
      const candleRepo = new PgCandleRepo(db);
      const ac = new AbortController();
      const log = makeLog();
      const candles = [candleAt(0, 1_000_000_000n), candleAt(1, 1_010_000_000n), candleAt(2, 1_020_000_000n)];

      // Fail the SECOND candle's commit exactly once, with a pg connection-class error. A retry that
      // works must leave all three equity rows behind; one that does not is short a row.
      let commits = 0;
      const bindRunRepo = (q: Queryable): RunRepo => {
        const real = new PgRunRepo(db, q);
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === 'insertEquity') {
              return async (...a: Parameters<RunRepo['insertEquity']>) => {
                commits++;
                if (commits === 2) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
                return target.insertEquity(...a);
              };
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        }) as RunRepo;
      };

      const result = await runPaper({
        db, runs, candleRepo, token: TOKEN, strategy: testStrategy([]),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--grace-sec', '0']),
        collectIntervalSec: 60, log, now: () => t(3), sleep: async () => {}, signal: ac.signal,
        feedFactory: scriptedFeed(candles, { stopAfter: 3, ac }), gitSha: 'testsha', bindRunRepo,
      });

      expect(commits, 'the failing commit was attempted a second time').toBeGreaterThan(3);
      expect(log.warn.mock.calls.some((c) => c[1] === 'candle commit failed; retrying')).toBe(true);
      const equity = await runs.listEquity(result.runId, new Date(0), t(59));
      expect(equity, 'the retried candle is present, not lost').toHaveLength(3);
      const run = await runs.getRun(result.runId);
      expect(run?.status).toBe('finished');
    });
  });

  it('rolls the whole candle back when its commit fails for good: no orphan order without its equity point', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedToken(db);
      const runs = new PgRunRepo(db);
      const candleRepo = new PgCandleRepo(db);
      const ac = new AbortController();
      const candles = [candleAt(0, 1_000_000_000n), candleAt(1, 1_010_000_000n), candleAt(2, 1_020_000_000n)];

      // A NON-transient failure on the third candle — the one that settles the buy. Its order must
      // not survive without the equity point that was written in the same transaction.
      const bindRunRepo = (q: Queryable): RunRepo => {
        const real = new PgRunRepo(db, q);
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === 'insertEquity') {
              return async (...a: Parameters<RunRepo['insertEquity']>) => {
                const points = a[1];
                if (points[0]?.tickTs.getTime() === t(2).getTime()) throw Object.assign(new Error('null value violates not-null constraint'), { code: '23502' });
                return target.insertEquity(...a);
              };
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        }) as RunRepo;
      };

      await expect(runPaper({
        db, runs, candleRepo, token: TOKEN, strategy: testStrategy([]),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--grace-sec', '0']),
        collectIntervalSec: 60, log: makeLog(), now: () => t(3), sleep: async () => {}, signal: ac.signal,
        feedFactory: scriptedFeed(candles, { stopAfter: 3, ac }), gitSha: 'testsha', bindRunRepo,
      })).rejects.toThrow(/not-null constraint/);

      const running = await runs.listRunning();
      const id = running.length ? running[0]!.id : null;
      const all = await db.query<{ n: string }>('SELECT count(*) AS n FROM run_equity');
      const orderCount = await db.query<{ n: string }>('SELECT count(*) AS n FROM paper_orders');
      expect(all.rows[0]?.n, 'the first two candles committed; the third did not').toBe('2');
      expect(orderCount.rows[0]?.n, 'the settled order rolled back with the equity point it shared a transaction with').toBe('0');
      expect(id).toBeNull(); // the catch block marked the run aborted, so nothing is left 'running'
    });
  });

  it('aborts the run when the feed fails too many boundaries in a row (finding I5)', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedToken(db);
      const runs = new PgRunRepo(db);
      const candleRepo = new PgCandleRepo(db);
      const ac = new AbortController();
      const candles = [candleAt(0, 1_000_000_000n), candleAt(1, 1_010_000_000n), candleAt(2, 1_020_000_000n)];

      const result = await runPaper({
        db, runs, candleRepo, token: TOKEN, strategy: testStrategy([]),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--grace-sec', '0', '--max-tick-failures', '2']),
        collectIntervalSec: 60, log: makeLog(), now: () => t(3), sleep: async () => {}, signal: ac.signal,
        feedFactory: scriptedFeed(candles, { failEveryTick: true }), gitSha: 'testsha',
      });

      const run = await runs.getRun(result.runId);
      expect(run).toMatchObject({ status: 'aborted' });
      expect(run?.stopReason).toBe('feed failing: read candles failed');
      expect(run?.params.feedCounters).toMatchObject({ tickFailures: 2 });
      expect(run?.summary?.warnings.some((w) => w.includes('feed-failure rule'))).toBe(true);
    });
  });

  it('resumes: seq continues, primeHistory is applied, and the resume is recorded (findings I6, C2)', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedToken(db);
      const runs = new PgRunRepo(db);
      const candleRepo = new PgCandleRepo(db);
      const first = [candleAt(0, 1_000_000_000n), candleAt(1, 1_010_000_000n), candleAt(2, 1_020_000_000n)];
      const second = [candleAt(3, 1_030_000_000n), candleAt(4, 1_040_000_000n)];
      // The resume reads its warm-up window out of `candles`, so the first segment's candles have to
      // actually be there — the same rows a real run's builder would have written.
      await candleRepo.insertCandles([...first, ...second].map(rowOf));

      const ac1 = new AbortController();
      const segment1 = await runPaper({
        db, runs, candleRepo, token: TOKEN, strategy: testStrategy([]),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--grace-sec', '0']),
        collectIntervalSec: 60, log: makeLog(), now: () => t(3), sleep: async () => {}, signal: ac1.signal,
        feedFactory: scriptedFeed(first, { stopAfter: 3, ac: ac1 }), gitSha: 'testsha',
      });
      const seqAfterFirst = await runs.lastOrderSeq(segment1.runId);
      expect(seqAfterFirst).toBeGreaterThan(0);

      const ac2 = new AbortController();
      const seenOnResume: number[] = [];
      await runPaper({
        db, runs, candleRepo, token: TOKEN, strategy: testStrategy(seenOnResume),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--resume', String(segment1.runId), '--grace-sec', '0']),
        collectIntervalSec: 60, log: makeLog(), now: () => t(6), sleep: async () => {}, signal: ac2.signal,
        feedFactory: scriptedFeed(second, { stopAfter: 2, ac: ac2 }), gitSha: 'testsha',
      });

      // I6: the FIRST live candle of the resumed segment already sees a full warm-up window, rather
      // than starting from one candle and being unable to decide for the next `warmup` boundaries.
      //
      // The length assertion is the load-bearing one. `seenOnResume[0] >= 2` was the obvious thing
      // to write and it is VACUOUS: unprimed, the strategy is simply not consulted on the first live
      // candle at all, so element 0 comes from the SECOND candle and is 2 either way. Reinjecting
      // "no primeHistory" left that assertion green. What actually separates the two worlds is
      // whether the strategy ran on EVERY live candle (2 here) or skipped the first (1).
      expect(seenOnResume, 'consulted on every live candle of the resumed segment, first one included').toHaveLength(second.length);
      expect(seenOnResume[0], 'two primed candles plus the first live one').toBe(3);

      const run = await runs.getRun(segment1.runId);
      expect(Array.isArray(run?.params.resumes) ? (run?.params.resumes as unknown[]).length : 0).toBe(1);
      expect(run?.status).toBe('finished');
      // Equity spans BOTH segments and the seqs never restart or collide.
      const equity = await runs.listEquity(segment1.runId, new Date(0), t(59));
      expect(equity).toHaveLength(5);
      const orders = await runs.listOrders(segment1.runId);
      expect(orders.map((o) => o.seq)).toEqual([...new Set(orders.map((o) => o.seq))].sort((x, y) => x - y));
      expect(await runs.lastOrderSeq(segment1.runId)).toBeGreaterThanOrEqual(seqAfterFirst);
      // I4: the counters continued across the resume rather than restarting at zero.
      expect(run?.params.feedCounters).toMatchObject({ ticks: 5 });
    });
  });

  it('refuses --cash-ada on a resume that has equity to restore (finding M5)', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedToken(db);
      const runs = new PgRunRepo(db);
      const candleRepo = new PgCandleRepo(db);
      const ac1 = new AbortController();
      const first = [candleAt(0, 1_000_000_000n), candleAt(1, 1_010_000_000n)];
      const segment1 = await runPaper({
        db, runs, candleRepo, token: TOKEN, strategy: testStrategy([]),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--grace-sec', '0']),
        collectIntervalSec: 60, log: makeLog(), now: () => t(3), sleep: async () => {}, signal: ac1.signal,
        feedFactory: scriptedFeed(first, { stopAfter: 2, ac: ac1 }), gitSha: 'testsha',
      });

      const ac2 = new AbortController();
      await expect(runPaper({
        db, runs, candleRepo, token: TOKEN, strategy: testStrategy([]),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--resume', String(segment1.runId), '--cash-ada', '5000', '--grace-sec', '0']),
        collectIntervalSec: 60, log: makeLog(), now: () => t(6), sleep: async () => {}, signal: ac2.signal,
        feedFactory: scriptedFeed([], {}), gitSha: 'testsha',
      })).rejects.toThrow(/--cash-ada is not allowed with --resume/);
    });
  });

  /**
   * Finding C2, restated after liveness became measurable.
   *
   * This test used to assert that a fresh heartbeat alone refuses a resume, on the reasoning that a
   * recent heartbeat implies a live process. That inference is what `resumeLiveness` replaces: in
   * this very test nothing was running, so "demonstrably alive" was never demonstrated. Each case
   * below now says which world it is in instead of leaving it to the clock.
   */
  it('refuses a resume while a process is running it, whatever the heartbeat says', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedToken(db);
      const runs = new PgRunRepo(db);
      const id = await runs.createRun({
        mode: 'paper', strategyId: 'ma-crossover', params: { intervalSec: 60, graceSec: 0 }, gitSha: 'testsha', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(0), status: 'running', rehearsal: false,
      });
      await runs.heartbeat(id, new Date(t(10).getTime() - 5_000), null); // fresh: bound is 2*60 + 0 = 120s
      const base = {
        db, runs, candleRepo: new PgCandleRepo(db), token: TOKEN, strategy: testStrategy([]),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--resume', String(id), '--grace-sec', '0']),
        collectIntervalSec: 60, log: makeLog(), sleep: async () => {}, gitSha: 'testsha',
        feedFactory: scriptedFeed([], {}), now: () => t(10), signal: new AbortController().signal,
      };
      await expect(runPaper({ ...base, resumeLiveness: () => ({ kind: 'counted', processes: 1 }) }))
        .rejects.toThrow(/already running \(1 process for this strategy\)/);

      // A STALE heartbeat does not excuse it either: a wedged process that stopped beating is still
      // a writer, and resuming into it is the two-writer race this whole rule exists to prevent.
      await runs.heartbeat(id, new Date(t(10).getTime() - 600_000), null);
      await expect(runPaper({ ...base, resumeLiveness: () => ({ kind: 'counted', processes: 1 }) }))
        .rejects.toThrow(/already running/);
    });
  });

  it('refuses a resume when the process table could not be read: an unknown is not an absence', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedToken(db);
      const runs = new PgRunRepo(db);
      const id = await runs.createRun({
        mode: 'paper', strategyId: 'ma-crossover', params: { intervalSec: 60, graceSec: 0 }, gitSha: 'testsha', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(0), status: 'running', rehearsal: false,
      });
      await runs.heartbeat(id, new Date(t(10).getTime() - 5_000), null);
      await expect(runPaper({
        db, runs, candleRepo: new PgCandleRepo(db), token: TOKEN, strategy: testStrategy([]),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--resume', String(id), '--grace-sec', '0']),
        collectIntervalSec: 60, log: makeLog(), sleep: async () => {}, gitSha: 'testsha',
        feedFactory: scriptedFeed([], {}), now: () => t(10), signal: new AbortController().signal,
        resumeLiveness: () => ({ kind: 'unknown' }),
      })).rejects.toThrow(/already running/);
    });
  });

  it('allows a resume once nothing is running it, even with a fresh heartbeat (the 31-minute gap)', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedToken(db);
      const runs = new PgRunRepo(db);
      const id = await runs.createRun({
        mode: 'paper', strategyId: 'ma-crossover', params: { intervalSec: 60, graceSec: 0 }, gitSha: 'testsha', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(0), status: 'running', rehearsal: false,
      });
      // Five seconds old: a run killed moments ago, which the heartbeat cannot know about for
      // another 2*intervalSec + graceSec. Measured on the real system 2026-09-08: run 138 was dead
      // and unresumable for half an hour on exactly this reasoning.
      await runs.heartbeat(id, new Date(t(10).getTime() - 5_000), null);
      await expect(runPaper({
        db, runs, candleRepo: new PgCandleRepo(db), token: TOKEN, strategy: testStrategy([]),
        args: parsePaperArgs(['ma-crossover', 'SNEK', '--resume', String(id), '--grace-sec', '0']),
        collectIntervalSec: 60, log: makeLog(), sleep: async () => {}, gitSha: 'testsha',
        feedFactory: scriptedFeed([], {}), now: () => t(10), signal: new AbortController().signal,
        resumeLiveness: () => ({ kind: 'counted', processes: 0 }),
      })).resolves.toBeDefined();

      const after = await runs.getRun(id);
      expect(Array.isArray(after?.params.resumes) ? (after?.params.resumes as unknown[]).length : 0).toBe(1);
      // The record must say WHY it was allowed. Calling this "stale" would be false: it was 5s old.
      const warnings = (after?.summary?.warnings ?? []) as string[];
      expect(warnings.some((w) => /heartbeat is still fresh \(age 5s\) but which no process was running/.test(w))).toBe(true);
    });
  });

});
