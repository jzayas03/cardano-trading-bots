import { decimalToNumber } from '@ctb/candles';
import type { Logger } from '@ctb/collector';
import { applyFill, equityLovelace } from './portfolio.js';
import type { Candle, EquityPoint, Executor, Intent, OrderRecord, Portfolio, RunCoverage, RunResult, RunSummaryStats, Strategy } from './types.js';

export interface RunEngineDeps {
  feed: Iterable<Candle> | AsyncIterable<Candle>;
  strategy: Strategy;
  params?: Record<string, number>;
  executor: Executor;
  initial: Portfolio;
  decimals: number;
  log: Logger;
  historyLimit?: number;
  /** Bucket width the feed is supposed to have, for the expected-bucket count in coverage. */
  intervalSec?: number;
  /** The executor's stale-fill bound, so coverage can count how many gaps will reject a fill. */
  maxGapMs?: number;
}

const DEFAULT_INTERVAL_SEC = 300;
const DEFAULT_MAX_GAP_MS = 15 * 60_000;

/** One loop for backtest and paper: intents from candle t are filled against candle t+1. */
export async function runEngine(d: RunEngineDeps): Promise<RunResult> {
  const params = { ...d.strategy.defaultParams, ...(d.params ?? {}) };
  // The warmup that matters is the one these params imply, not the one the defaults imply: a run
  // with --param slow=5000 needs 5001 candles and must say so rather than trade nothing (finding I5).
  const warmup = d.strategy.warmupFor(params);
  const historyLimit = d.historyLimit ?? Math.max(warmup * 4, 64);
  if (historyLimit < warmup) {
    throw new Error(`historyLimit ${historyLimit} is below strategy ${d.strategy.id} warmup ${warmup} for these params: it could never emit an intent`);
  }
  const intervalMs = (d.intervalSec ?? DEFAULT_INTERVAL_SEC) * 1000;
  const maxGapMs = d.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const history: Candle[] = [];
  const closes: number[] = [];
  const orders: OrderRecord[] = [];
  const equity: EquityPoint[] = [];
  let portfolio: Portfolio = { ...d.initial };
  let pending: Array<{ tsIntent: Date; at: Candle; intent: Intent }> = [];
  let seq = 0;
  let candles = 0;
  let firstTs: Date | null = null;
  let lastTs: Date | null = null;
  let widestGapMs = 0;
  let gapsOverBound = 0;

  for await (const candle of d.feed as AsyncIterable<Candle>) {
    candles++;
    if (lastTs !== null) {
      const gap = candle.tickTs.getTime() - lastTs.getTime();
      if (gap > widestGapMs) widestGapMs = gap;
      if (gap > maxGapMs) gapsOverBound++;
    }
    firstTs ??= candle.tickTs;
    lastTs = candle.tickTs;
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
    if (history.length >= warmup) {
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
  const coverage: RunCoverage = {
    candles,
    first: firstTs?.toISOString() ?? null,
    last: lastTs?.toISOString() ?? null,
    expectedBuckets: firstTs && lastTs ? Math.floor((lastTs.getTime() - firstTs.getTime()) / intervalMs) + 1 : 0,
    maxGapMs: widestGapMs,
    gapsOverBound,
  };
  const warnings: string[] = [];
  if (orders.length === 0) {
    // A run that emitted nothing is indistinguishable from a run that found no signal unless someone
    // says which it was. Params, warmup, and candle count are what tell them apart (finding I5).
    const warning = `strategy ${d.strategy.id} produced zero intents over ${candles} candles (warmup ${warmup}, params ${JSON.stringify(params)})`;
    warnings.push(warning);
    d.log.warn({ strategy: d.strategy.id, candles, warmup, params }, 'run produced zero intents');
  }
  const summary = summarize(orders, equity, coverage, warnings);
  d.log.info({ strategy: d.strategy.id, ...summary }, 'engine run finished');
  return { orders, equity, final: portfolio, summary };
}

export function summarize(orders: OrderRecord[], equity: EquityPoint[], coverage: RunCoverage, warnings: string[] = []): RunSummaryStats {
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
    candles: coverage.candles, intents: orders.length, filled, rejected: orders.length - filled,
    startEquityLovelace: start.toString(), endEquityLovelace: end.toString(),
    returnPct: start > 0n ? Number((end - start) * 10_000n / start) / 100 : 0,
    maxDrawdownPct: maxDd, feesLovelace: fees.toString(), poolFeesIn: poolFees.toString(), rejectReasons,
    coverage, warnings,
  };
}
