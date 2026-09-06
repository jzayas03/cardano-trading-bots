/** Base-10 decimal string. The only representation of a price that crosses a package boundary. */
export type Decimal = string;

export interface SnapshotForCandle {
  tickTs: Date;
  poolId: string;
  reserveBase: bigint;
  reserveQuote: bigint;
  feeBps: number;
  poolType: 'cpmm';
  tvlLovelace: bigint;
}

export interface CandleRow {
  baseUnit: string;
  tickTs: Date;
  poolId: string;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  closeReserveBase: bigint;
  closeReserveQuote: bigint;
  feeBps: number;
  poolType: 'cpmm';
  tvlLovelace: bigint;
  /** Reserve delta vs the previous candle of the SAME pool; null when the pool changed or there is no previous. */
  netFlowBase: bigint | null;
  netFlowQuote: bigint | null;
}
