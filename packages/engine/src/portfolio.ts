import { PRICE_SCALE, type Decimal } from '@ctb/candles';
import type { FillResult, Portfolio } from './types.js';

type Filled = Extract<FillResult, { status: 'filled' }>;

export function applyFill(p: Portfolio, r: Filled, side: 'buy' | 'sell'): Portfolio {
  const lovelaceFees = r.batcherFeeLovelace + r.networkFeeLovelace;
  const next: Portfolio = side === 'buy'
    ? { cashLovelace: p.cashLovelace - r.amountIn - lovelaceFees, positionBase: p.positionBase + r.amountOut }
    : { cashLovelace: p.cashLovelace + r.amountOut - lovelaceFees, positionBase: p.positionBase - r.amountIn };
  if (next.cashLovelace < 0n || next.positionBase < 0n) throw new Error(`fill would make the portfolio negative: cash=${next.cashLovelace} position=${next.positionBase}`);
  return next;
}

/** price is ADA per whole token as an 18-place decimal; position is in smallest units. */
export function equityLovelace(p: Portfolio, price: Decimal, decimals: number): bigint {
  const [intPart, frac = ''] = price.split('.');
  const scaled = BigInt(intPart + frac.padEnd(PRICE_SCALE, '0').slice(0, PRICE_SCALE)); // price * 1e18
  const positionValue = (p.positionBase * scaled * 1_000_000n) / (10n ** BigInt(decimals) * 10n ** BigInt(PRICE_SCALE));
  return p.cashLovelace + positionValue;
}
