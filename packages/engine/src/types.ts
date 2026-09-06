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
export interface Strategy { id: string; warmup: number; defaultParams: Record<string, number>; onCandle(ctx: StrategyContext): Intent[] }
export type FillResult =
  | { status: 'filled'; poolId: string; unitIn: string; amountIn: bigint; unitOut: string; amountOut: bigint; midPrice: Decimal; fillPrice: Decimal;
      poolFeeIn: bigint; batcherFeeLovelace: bigint; networkFeeLovelace: bigint; slippageBps: number; tsFill: Date }
  | { status: 'rejected'; reason: string };
export interface Executor { fill(intent: Intent, at: Candle, next: Candle, portfolio: Readonly<Portfolio>): FillResult }
export interface OrderRecord { seq: number; tsIntent: Date; intent: Intent; result: FillResult }
export interface EquityPoint { tickTs: Date; cashLovelace: bigint; positionBase: bigint; equityLovelace: bigint; price: Decimal }
export interface RunSummaryStats {
  candles: number; intents: number; filled: number; rejected: number;
  startEquityLovelace: string; endEquityLovelace: string; returnPct: number; maxDrawdownPct: number;
  feesLovelace: string; poolFeesIn: string; rejectReasons: Record<string, number>;
}
export interface RunResult { orders: OrderRecord[]; equity: EquityPoint[]; final: Portfolio; summary: RunSummaryStats }
