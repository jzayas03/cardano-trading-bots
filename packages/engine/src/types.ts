import type { Decimal } from '@ctb/candles';

export interface Candle {
  tickTs: Date; open: Decimal; high: Decimal; low: Decimal; close: Decimal;
  volumeQuote: Decimal | null;
  poolId: string | null; poolType: 'cpmm' | null; feeBps: number | null;
  closeReserveBase: bigint | null; closeReserveQuote: bigint | null; tvlLovelace: bigint | null;
}
export interface Intent { side: 'buy' | 'sell'; amountIn: bigint; reason: string }
export interface Portfolio { cashLovelace: bigint; positionBase: bigint }
/** A pool's reserves and fee at a point in time — resolved from a candle, or carried forward as `poolAfter` from an earlier fill in the same candle so the next intent trades against a depleted pool. */
export interface WorkingPool { poolId: string; reserveBase: bigint; reserveQuote: bigint; feeBps: number }
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
      /** Reserves of the traded pool right after this fill, so a second intent decided on the same
       * candle trades against a depleted pool instead of the same one twice; null when the executor
       * does not model reserves (e.g. a no-fee passthrough in tests). */
      poolAfter: WorkingPool | null;
      tsFill: Date }
  | { status: 'rejected'; reason: string };
export interface Executor {
  /** `working`, when present, overrides the reserves the loop would otherwise resolve from `next` —
   * it is the `poolAfter` of an earlier fill decided on the same candle. */
  fill(intent: Intent, at: Candle, next: Candle, portfolio: Readonly<Portfolio>, working?: WorkingPool): FillResult;
  /** Value the position right now, net of the fees a real exit would pay; null when the executor cannot price it (e.g. no reserves at this candle). Must never throw. */
  markToMarket(portfolio: Readonly<Portfolio>, candle: Candle): bigint | null;
}
export interface OrderRecord { seq: number; tsIntent: Date; intent: Intent; result: FillResult }
export interface EquityPoint {
  tickTs: Date; cashLovelace: bigint; positionBase: bigint; equityLovelace: bigint;
  /** What the position would fetch if sold now, net of fees, from `executor.markToMarket`; null when the executor cannot price it. */
  equityExecutableLovelace: bigint | null;
  price: Decimal;
}
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
  /**
   * Distinct `Candle.poolId` values consumed by this run (candles with a null `poolId` don't count).
   * The candle builder always picks the single deepest pool per tick, but when a venue drops out the
   * next-deepest is promoted and the series continues on it — two pools are not the same price series
   * (different fee, different depth, a quote step that is a venue change, not a market move).
   * `undefined` on a run persisted before this field existed: never read that as 0 or 1, which would
   * claim single-venue provenance nothing actually checked (`coverageLine` says "not recorded").
   */
  distinctPools?: number;
}
export interface RunSummaryStats {
  candles: number; intents: number; filled: number; rejected: number;
  startEquityLovelace: string; endEquityLovelace: string; returnPct: number; maxDrawdownPct: number;
  feesLovelace: string;
  /**
   * DEPRECATED and mixed-unit: `poolFeeIn` is taken from the order's INPUT, which is lovelace on a
   * buy and token subunits on a sell, so this summed two different assets into one number that was
   * printed on every report. Retained only because runs persisted before 2026-09-09 carry it.
   * Read `poolFeesInLovelace` / `poolFeesInBase` instead; they are absent on those older runs, and
   * absent must read as "not recorded", never as zero.
   */
  poolFeesIn: string;
  poolFeesInLovelace?: string;
  poolFeesInBase?: string;
  rejectReasons: Record<string, number>;
  coverage: RunCoverage;
  /** Non-fatal things the operator must see before reading the numbers, e.g. a run that never traded. */
  warnings: string[];
}
export interface RunResult { orders: OrderRecord[]; equity: EquityPoint[]; final: Portfolio; summary: RunSummaryStats }
