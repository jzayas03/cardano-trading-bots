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
      amountOut: out, midPrice: _at.close, fillPrice: next.close, poolFeeIn: 0n, batcherFeeLovelace: 0n, networkFeeLovelace: 0n, slippageBps: 0, tsFill: next.tickTs };
  },
};

const buyOnceThenSell: Strategy = {
  id: 'test', warmup: 2, defaultParams: {},
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
    const s: Strategy = { id: 'late', warmup: 1, defaultParams: {}, onCandle: (ctx) => (ctx.history.length === 2 ? [{ side: 'buy', amountIn: 1n, reason: 'late' }] : []) };
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
    const s: Strategy = { id: 'h', warmup: 1, defaultParams: {}, onCandle: (ctx) => { maxSeen = Math.max(maxSeen, ctx.history.length); return []; } };
    await runEngine({ feed: Array.from({ length: 30 }, (_, i) => c(i, '1')), strategy: s, executor: passthrough, initial: { cashLovelace: 0n, positionBase: 0n }, decimals: 0, log, historyLimit: 10 });
    expect(maxSeen).toBe(10);
  });
});
