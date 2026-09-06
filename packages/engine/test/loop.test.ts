import { describe, expect, it } from 'vitest';
import { runEngine, type Candle, type Executor, type FillResult, type Intent, type Strategy } from '../src/index.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const c = (i: number, close: string): Candle => ({
  tickTs: new Date(Date.UTC(2026, 8, 6, 0, 5 * i)), open: close, high: close, low: close, close, volumeQuote: null,
  poolId: 'p', poolType: 'cpmm', feeBps: 30, closeReserveBase: 1_000_000n, closeReserveQuote: 1_000_000_000n, tvlLovelace: 2_000_000_000n,
});

/** Fills at next.close with no fees; enough to test the loop's mechanics. */
const passthrough: Executor = {
  fill(intent, _at, next): FillResult {
    const px = Number(next.close);
    const out = intent.side === 'buy' ? BigInt(Math.floor(Number(intent.amountIn) / px / 1e6)) : BigInt(Math.floor(Number(intent.amountIn) * px * 1e6));
    return { status: 'filled', poolId: 'p', unitIn: intent.side === 'buy' ? 'lovelace' : 'base', amountIn: intent.amountIn, unitOut: intent.side === 'buy' ? 'base' : 'lovelace',
      amountOut: out, midPrice: _at.close, fillPrice: next.close, poolFeeIn: 0n, batcherFeeLovelace: 0n, networkFeeLovelace: 0n, slippageBps: 0, priceImpactBps: 0, tsFill: next.tickTs };
  },
};

const buyOnceThenSell: Strategy = {
  id: 'test', warmup: 2, defaultParams: {}, warmupFor: () => 2,
  onCandle(ctx): Intent[] {
    if (ctx.history.length === 2 && ctx.portfolio.positionBase === 0n) return [{ side: 'buy', amountIn: 100_000_000n, reason: 'first' }];
    if (ctx.history.length === 4 && ctx.portfolio.positionBase > 0n) return [{ side: 'sell', amountIn: ctx.portfolio.positionBase, reason: 'exit' }];
    return [];
  },
};

describe('runEngine', () => {
  it('fills intents at t+1, respects warmup, rejects the last candle intents, and summarizes', async () => {
    const feed = [c(0, '1.0'), c(1, '1.0'), c(2, '2.0'), c(3, '2.0'), c(4, '4.0'), c(5, '4.0')];
    const r = await runEngine({ feed, strategy: buyOnceThenSell, executor: passthrough, initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log });
    expect(r.orders).toHaveLength(2);
    expect(r.orders[0]?.tsIntent).toEqual(feed[1]!.tickTs); // decided on candle index 1 (warmup 2)
    expect(r.orders[0]?.result.status).toBe('filled');
    expect((r.orders[0]?.result as { tsFill: Date }).tsFill).toEqual(feed[2]!.tickTs); // filled on t+1
    expect(r.orders[0]?.seq).toBe(1);
    expect(r.orders[1]?.intent.side).toBe('sell');
    expect(r.final.positionBase).toBe(0n);
    expect(r.equity).toHaveLength(6);
    expect(r.summary.candles).toBe(6);
    expect(r.summary.filled).toBe(2);
    expect(r.summary.returnPct).toBeGreaterThan(0); // bought at 2.0, sold at 4.0
    expect(r.summary.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it('records a rejected order when there is no t+1 candle', async () => {
    const s: Strategy = { id: 'late', warmup: 1, defaultParams: {}, warmupFor: () => 1, onCandle: (ctx) => (ctx.history.length === 2 ? [{ side: 'buy', amountIn: 1n, reason: 'late' }] : []) };
    const r = await runEngine({ feed: [c(0, '1'), c(1, '1')], strategy: s, executor: passthrough, initial: { cashLovelace: 10n, positionBase: 0n }, decimals: 0, log });
    expect(r.orders[0]?.result).toEqual({ status: 'rejected', reason: 'no t+1 candle' });
    expect(r.summary.rejectReasons).toEqual({ 'no t+1 candle': 1 });
  });

  it('is deterministic: two runs produce identical orders and equity', async () => {
    const feed = Array.from({ length: 40 }, (_, i) => c(i, (1 + 0.1 * Math.sin(i / 3)).toFixed(6)));
    const run = () => runEngine({ feed, strategy: buyOnceThenSell, executor: passthrough, initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log });
    const [a, b] = await Promise.all([run(), run()]);
    const ser = (r: Awaited<ReturnType<typeof run>>) => JSON.stringify({ o: r.orders, e: r.equity }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(ser(a)).toBe(ser(b));
  });

  it('trims history to historyLimit', async () => {
    let maxSeen = 0;
    const s: Strategy = { id: 'h', warmup: 1, defaultParams: {}, warmupFor: () => 1, onCandle: (ctx) => { maxSeen = Math.max(maxSeen, ctx.history.length); return []; } };
    await runEngine({ feed: Array.from({ length: 30 }, (_, i) => c(i, '1')), strategy: s, executor: passthrough, initial: { cashLovelace: 0n, positionBase: 0n }, decimals: 0, log, historyLimit: 10 });
    expect(maxSeen).toBe(10);
  });
});

/**
 * Finding C3: a backtest over sparse external history was reporting P&L without ever saying how much
 * of the window it actually saw. Coverage is computed by the loop itself, from the feed it consumed,
 * and lands in the run summary (jsonb — no migration).
 */
describe('runEngine coverage stats', () => {
  const quiet: Strategy = { id: 'quiet', warmup: 1, defaultParams: {}, warmupFor: () => 1, onCandle: () => [] };

  it('reports first, last, expected buckets, the widest gap, and how many gaps beat the bound', async () => {
    // 5-minute buckets with two holes: 0, 5, 10, then a 60-minute jump to 70, then 75.
    const at = (m: number): Candle => ({ ...c(0, '1'), tickTs: new Date(Date.UTC(2026, 8, 6, 0, m)) });
    const feed = [at(0), at(5), at(10), at(70), at(75)];
    const r = await runEngine({ feed, strategy: quiet, executor: passthrough, initial: { cashLovelace: 0n, positionBase: 0n }, decimals: 0, log,
      intervalSec: 300, maxGapMs: 15 * 60_000 });
    expect(r.summary.coverage).toEqual({
      candles: 5,
      first: new Date(Date.UTC(2026, 8, 6, 0, 0)).toISOString(),
      last: new Date(Date.UTC(2026, 8, 6, 0, 75)).toISOString(),
      expectedBuckets: 16, // 75 minutes / 5 + 1
      maxGapMs: 60 * 60_000,
      gapsOverBound: 1,
    });
    expect(r.summary.candles).toBe(5);
  });

  it('reports an empty window without inventing a range', async () => {
    const r = await runEngine({ feed: [], strategy: quiet, executor: passthrough, initial: { cashLovelace: 0n, positionBase: 0n }, decimals: 0, log });
    expect(r.summary.coverage).toEqual({ candles: 0, first: null, last: null, expectedBuckets: 0, maxGapMs: 0, gapsOverBound: 0 });
  });
});

/**
 * Finding I5: `--param slow=5000` on a 200-candle window used to produce a silent zero-trade run that
 * read exactly like "the strategy found no signal". The warmup is now derived from the params in
 * force, checked against the history the loop will keep, and a zero-intent run says so out loud.
 */
describe('runEngine warmup and zero-intent warning', () => {
  const paramWarmup: Strategy = {
    id: 'pw', warmup: 3, defaultParams: { slow: 2 }, warmupFor: (p) => (p.slow ?? 2) + 1,
    onCandle: (ctx) => (ctx.history.length === ctx.params.slow! + 1 ? [{ side: 'buy', amountIn: 1_000n, reason: 'go' }] : []),
  };

  it('uses warmupFor(params), not the default-params warmup', async () => {
    const seen: number[] = [];
    const s: Strategy = { ...paramWarmup, onCandle: (ctx) => { seen.push(ctx.history.length); return []; } };
    await runEngine({ feed: Array.from({ length: 8 }, (_, i) => c(i, '1')), strategy: s, params: { slow: 5 }, executor: passthrough,
      initial: { cashLovelace: 0n, positionBase: 0n }, decimals: 0, log });
    expect(seen[0], 'warmupFor({slow: 5}) is 6, so the first decision is on the 6th candle').toBe(6);
  });

  it('throws when historyLimit cannot hold the warmup these params need', async () => {
    await expect(runEngine({ feed: [c(0, '1')], strategy: paramWarmup, params: { slow: 100 }, executor: passthrough,
      initial: { cashLovelace: 0n, positionBase: 0n }, decimals: 0, log, historyLimit: 10 })).rejects.toThrow(/warmup 101/);
  });

  it('warns, and records the warning on the summary, when a completed run produced zero intents', async () => {
    const warned: string[] = [];
    const noisy = { info: () => {}, warn: (_o: unknown, msg: string) => { warned.push(msg); }, error: () => {} };
    const never: Strategy = { id: 'never', warmup: 1, defaultParams: {}, warmupFor: () => 1, onCandle: () => [] };
    const r = await runEngine({ feed: Array.from({ length: 5 }, (_, i) => c(i, '1')), strategy: never, executor: passthrough,
      initial: { cashLovelace: 1_000n, positionBase: 0n }, decimals: 0, log: noisy });
    expect(r.summary.warnings).toHaveLength(1);
    expect(r.summary.warnings[0]).toMatch(/zero intents/);
    expect(warned).toHaveLength(1);
  });

  it('records no warning when the run did trade', async () => {
    const feed = [c(0, '1.0'), c(1, '1.0'), c(2, '2.0'), c(3, '2.0'), c(4, '4.0'), c(5, '4.0')];
    const r = await runEngine({ feed, strategy: buyOnceThenSell, executor: passthrough, initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log });
    expect(r.summary.warnings).toEqual([]);
  });
});
