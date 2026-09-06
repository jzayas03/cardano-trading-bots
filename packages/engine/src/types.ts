import type { Decimal } from '@ctb/candles';

export interface Candle {
  tickTs: Date; open: Decimal; high: Decimal; low: Decimal; close: Decimal;
  volumeQuote: Decimal | null;
  poolId: string | null; poolType: 'cpmm' | null; feeBps: number | null;
  closeReserveBase: bigint | null; closeReserveQuote: bigint | null; tvlLovelace: bigint | null;
}
export interface Intent { side: 'buy' | 'sell'; amountIn: bigint; reason: string }
export interface Portfolio { cashLovelace: bigint; positionBase: bigint }
export interface StrategyContext { candle: Candle; history: Candle[]; closes: number[]; portfolio: Readonly<Portfolio>; params: Record<string, number> }
export interface Strategy {
  id: string;
  /** Warmup under `defaultParams`. Informational: the loop always asks `warmupFor` instead. */
  warmup: number;
  defaultParams: Record<string, number>;
  /**
   * Candles the strategy needs before `onCandle` can emit anything, for THESE params. `--param
   * slow=5000` on a 200-candle window is a misconfigured run, not a strategy that found no signal,
   * and only the strategy knows the difference (finding I5).
   */
  warmupFor(params: Record<string, number>): number;
  onCandle(ctx: StrategyContext): Intent[];
}
export type FillResult =
  | { status: 'filled'; poolId: string; unitIn: string; amountIn: bigint; unitOut: string; amountOut: bigint; midPrice: Decimal; fillPrice: Decimal;
      poolFeeIn: bigint; batcherFeeLovelace: bigint; networkFeeLovelace: bigint;
      /** Fill against the mid at t — the price the strategy decided on (spec §4.5). */
      slippageBps: number;
      /** Fill against the t+1 pool's own mid — how much of the move was this trade in that pool. */
      priceImpactBps: number;
      tsFill: Date }
  | { status: 'rejected'; reason: string };
export interface Executor { fill(intent: Intent, at: Candle, next: Candle, portfolio: Readonly<Portfolio>): FillResult }
export interface OrderRecord { seq: number; tsIntent: Date; intent: Intent; result: FillResult }
export interface EquityPoint { tickTs: Date; cashLovelace: bigint; positionBase: bigint; equityLovelace: bigint; price: Decimal }
/** How much of the requested window the feed actually held. Sparse history makes a P&L number unreadable without it (finding C3). */
export interface RunCoverage {
  candles: number;
  first: string | null;
  last: string | null;
  /** Buckets the window first..last would hold at the run's interval, if nothing were missing. */
  expectedBuckets: number;
  /** Widest observed distance between consecutive candles, in ms. */
  maxGapMs: number;
  /** Consecutive pairs wider than the executor's stale-fill bound: an intent decided in one of those is rejected. */
  gapsOverBound: number;
}
export interface RunSummaryStats {
  candles: number; intents: number; filled: number; rejected: number;
  startEquityLovelace: string; endEquityLovelace: string; returnPct: number; maxDrawdownPct: number;
  feesLovelace: string; poolFeesIn: string; rejectReasons: Record<string, number>;
  coverage: RunCoverage;
  /** Non-fatal things the operator must see before reading the numbers, e.g. a run that never traded. */
  warnings: string[];
}
export interface RunResult { orders: OrderRecord[]; equity: EquityPoint[]; final: Portfolio; summary: RunSummaryStats }
