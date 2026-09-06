import { decimalToNumber } from '@ctb/candles';
import type { Logger } from '@ctb/collector';
import { applyFill, equityLovelace } from './portfolio.js';
import type { Candle, EquityPoint, Executor, Intent, OrderRecord, Portfolio, RunResult, RunSummaryStats, Strategy } from './types.js';

export interface RunEngineDeps {
  feed: Iterable<Candle> | AsyncIterable<Candle>;
  strategy: Strategy;
  params?: Record<string, number>;
  executor: Executor;
  initial: Portfolio;
  decimals: number;
  log: Logger;
  historyLimit?: number;
}

/** One loop for backtest and paper: intents from candle t are filled against candle t+1. */
export async function runEngine(d: RunEngineDeps): Promise<RunResult> {
  const params = { ...d.strategy.defaultParams, ...(d.params ?? {}) };
  const historyLimit = d.historyLimit ?? Math.max(d.strategy.warmup * 4, 64);
  const history: Candle[] = [];
  const closes: number[] = [];
  const orders: OrderRecord[] = [];
  const equity: EquityPoint[] = [];
  let portfolio: Portfolio = { ...d.initial };
  let pending: Array<{ tsIntent: Date; at: Candle; intent: Intent }> = [];
  let seq = 0;
  let candles = 0;

  for await (const candle of d.feed as AsyncIterable<Candle>) {
    candles++;
    // 1. settle what was decided on the previous candle
    for (const p of pending) {
      seq++;
      const result = d.executor.fill(p.intent, p.at, candle, portfolio);
      if (result.status === 'filled') portfolio = applyFill(portfolio, result, p.intent.side);
      orders.push({ seq, tsIntent: p.tsIntent, intent: p.intent, result });
    }
    pending = [];
    // 2. observe
    history.push(candle);
    closes.push(decimalToNumber(candle.close));
    if (history.length > historyLimit) { history.shift(); closes.shift(); }
    equity.push({ tickTs: candle.tickTs, cashLovelace: portfolio.cashLovelace, positionBase: portfolio.positionBase, equityLovelace: equityLovelace(portfolio, candle.close, d.decimals), price: candle.close });
    // 3. decide
    if (history.length >= d.strategy.warmup) {
      const intents = d.strategy.onCandle({ candle, history: [...history], closes: [...closes], portfolio, params });
      for (const intent of intents) {
        if (intent.amountIn <= 0n) throw new Error(`strategy ${d.strategy.id} emitted a non-positive amountIn`);
        pending.push({ tsIntent: candle.tickTs, at: candle, intent });
      }
    }
  }
  for (const p of pending) {
    seq++;
    orders.push({ seq, tsIntent: p.tsIntent, intent: p.intent, result: { status: 'rejected', reason: 'no t+1 candle' } });
  }
  const summary = summarize(orders, equity, candles);
  d.log.info({ strategy: d.strategy.id, ...summary }, 'engine run finished');
  return { orders, equity, final: portfolio, summary };
}

export function summarize(orders: OrderRecord[], equity: EquityPoint[], candles: number): RunSummaryStats {
  const start = equity[0]?.equityLovelace ?? 0n;
  const end = equity.at(-1)?.equityLovelace ?? 0n;
  let peak = 0n;
  let maxDd = 0;
  for (const e of equity) {
    if (e.equityLovelace > peak) peak = e.equityLovelace;
    if (peak > 0n) {
      const dd = Number((peak - e.equityLovelace) * 10_000n / peak) / 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  let fees = 0n;
  let poolFees = 0n;
  const rejectReasons: Record<string, number> = {};
  let filled = 0;
  for (const o of orders) {
    if (o.result.status === 'filled') { filled++; fees += o.result.batcherFeeLovelace + o.result.networkFeeLovelace; poolFees += o.result.poolFeeIn; }
    else rejectReasons[o.result.reason] = (rejectReasons[o.result.reason] ?? 0) + 1;
  }
  return {
    candles, intents: orders.length, filled, rejected: orders.length - filled,
    startEquityLovelace: start.toString(), endEquityLovelace: end.toString(),
    returnPct: start > 0n ? Number((end - start) * 10_000n / start) / 100 : 0,
    maxDrawdownPct: maxDd, feesLovelace: fees.toString(), poolFeesIn: poolFees.toString(), rejectReasons,
  };
}
