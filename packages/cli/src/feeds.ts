import type { CandleRepo, Denomination, ExternalRepo } from '@ctb/candles';
import type { Candle } from '@ctb/engine';

export async function* localCandleFeed(repo: CandleRepo, unit: string, from: Date, to: Date): AsyncIterable<Candle> {
  for (const r of await repo.readCandles(unit, from, to)) {
    yield { tickTs: r.tickTs, open: r.open, high: r.high, low: r.low, close: r.close, volumeQuote: null, poolId: r.poolId, poolType: r.poolType, feeBps: r.feeBps,
      closeReserveBase: r.closeReserveBase, closeReserveQuote: r.closeReserveQuote, tvlLovelace: r.tvlLovelace };
  }
}

export async function* externalCandleFeed(repo: ExternalRepo, unit: string, from: Date, to: Date, denomination: Denomination): AsyncIterable<Candle> {
  for (const r of await repo.readExternal(unit, from, to, denomination)) {
    yield { tickTs: r.tickTs, open: r.open, high: r.high, low: r.low, close: r.close, volumeQuote: r.volumeQuote, poolId: null, poolType: null, feeBps: null,
      closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null };
  }
}
