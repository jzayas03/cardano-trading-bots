import { formatScaled, PRICE_SCALE, type Decimal } from '@ctb/candles';
import type { Candle, Executor, FillResult, Intent, Portfolio } from '@ctb/engine';
import { costsForPoolId, DEFAULT_COSTS, type VenueCosts } from './costs.js';
import { cpmmAmountOut, poolFeeTaken } from './cpmm.js';

export type FillModel = { kind: 'cpmm_observed' } | { kind: 'cpmm_synthetic_depth'; depthLovelace: bigint };

export interface SimExecutorOptions { decimals: number; baseUnit: string; fillModel: FillModel; costOverrides?: Partial<VenueCosts> }

const SCALE = 10n ** BigInt(PRICE_SCALE);
const SYNTHETIC_FEE_BPS = 30;

function scaledPrice(d: Decimal): bigint {
  const [i, f = ''] = d.split('.');
  return BigInt(i + f.padEnd(PRICE_SCALE, '0').slice(0, PRICE_SCALE));
}

/** ADA per whole token from a lovelace/base amount pair, 18 places. */
function priceFromAmounts(lovelace: bigint, base: bigint, decimals: number): Decimal {
  return formatScaled((lovelace * 10n ** BigInt(decimals) * SCALE) / (base * 1_000_000n));
}

export class SimExecutor implements Executor {
  constructor(private readonly o: SimExecutorOptions) {}

  fill(intent: Intent, at: Candle, next: Candle, portfolio: Readonly<Portfolio>): FillResult {
    const pool = this.resolvePool(next);
    if ('reason' in pool) return { status: 'rejected', reason: pool.reason };
    const costs = pool.poolId === 'synthetic' ? { ...DEFAULT_COSTS, ...this.o.costOverrides } : costsForPoolId(pool.poolId, this.o.costOverrides);
    const lovelaceFees = costs.batcherFeeLovelace + costs.networkFeeLovelace;
    const isBuy = intent.side === 'buy';
    if (isBuy && portfolio.cashLovelace < intent.amountIn + lovelaceFees) return { status: 'rejected', reason: 'insufficient cash' };
    if (!isBuy && portfolio.positionBase < intent.amountIn) return { status: 'rejected', reason: 'insufficient position' };
    const reserveIn = isBuy ? pool.reserveQuote : pool.reserveBase;
    const reserveOut = isBuy ? pool.reserveBase : pool.reserveQuote;
    const amountOut = cpmmAmountOut(intent.amountIn, reserveIn, reserveOut, pool.feeBps);
    if (amountOut <= 0n) return { status: 'rejected', reason: 'dust' };
    if (!isBuy && portfolio.cashLovelace + amountOut < lovelaceFees) return { status: 'rejected', reason: 'insufficient cash' };
    const midRaw = Number(pool.reserveQuote) / Number(pool.reserveBase);
    const fillRaw = isBuy ? Number(intent.amountIn) / Number(amountOut) : Number(amountOut) / Number(intent.amountIn);
    const slippageBps = Math.round((isBuy ? fillRaw / midRaw - 1 : 1 - fillRaw / midRaw) * 10_000);
    const fillPrice = isBuy ? priceFromAmounts(intent.amountIn, amountOut, this.o.decimals) : priceFromAmounts(amountOut, intent.amountIn, this.o.decimals);
    return {
      status: 'filled', poolId: pool.poolId,
      unitIn: isBuy ? 'lovelace' : this.o.baseUnit, amountIn: intent.amountIn,
      unitOut: isBuy ? this.o.baseUnit : 'lovelace', amountOut,
      midPrice: at.close, fillPrice,
      poolFeeIn: poolFeeTaken(intent.amountIn, pool.feeBps),
      batcherFeeLovelace: costs.batcherFeeLovelace, networkFeeLovelace: costs.networkFeeLovelace,
      slippageBps, tsFill: next.tickTs,
    };
  }

  private resolvePool(next: Candle): { poolId: string; reserveBase: bigint; reserveQuote: bigint; feeBps: number } | { reason: string } {
    if (this.o.fillModel.kind === 'cpmm_observed') {
      if (next.poolType !== null && next.poolType !== 'cpmm') return { reason: `pool_type ${String(next.poolType)} not cpmm` };
      if (!next.poolId) return { reason: 'no pool at t+1' };
      if (next.closeReserveBase === null || next.closeReserveQuote === null || next.closeReserveBase <= 0n || next.closeReserveQuote <= 0n || next.feeBps === null) {
        return { reason: 'no reserves at t+1' };
      }
      if (next.poolType !== 'cpmm') return { reason: 'no reserves at t+1' };
      return { poolId: next.poolId, reserveBase: next.closeReserveBase, reserveQuote: next.closeReserveQuote, feeBps: next.feeBps };
    }
    const depth = this.o.fillModel.depthLovelace;
    if (depth <= 0n) return { reason: 'synthetic depth must be positive' };
    const p = scaledPrice(next.close);
    if (p <= 0n) return { reason: 'no price at t+1' };
    const reserveBase = (depth * 10n ** BigInt(this.o.decimals) * SCALE) / (p * 1_000_000n);
    if (reserveBase <= 0n) return { reason: 'synthetic depth too small for price' };
    return { poolId: next.poolId ?? 'synthetic', reserveBase, reserveQuote: depth, feeBps: next.feeBps ?? SYNTHETIC_FEE_BPS };
  }
}
