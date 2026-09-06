import { decimalToScaled, formatScaled, PRICE_SCALE, priceAdaPerToken, type Decimal } from '@ctb/candles';
import type { Candle, Executor, FillResult, Intent, Portfolio } from '@ctb/engine';
import { DEFAULT_COSTS, tryCostsForPoolId, venueOf, type VenueCosts } from './costs.js';
import { cpmmAmountOut, poolFeeTaken } from './cpmm.js';

export type FillModel = { kind: 'cpmm_observed' } | { kind: 'cpmm_synthetic_depth'; depthLovelace: bigint };

export interface SimExecutorOptions {
  decimals: number;
  baseUnit: string;
  fillModel: FillModel;
  /**
   * Largest tolerated distance between the candle an intent was decided on and the candle it is
   * filled against. Required, with no default: external history is sparse (561 of 4968 consecutive
   * SNEK pairs are over an hour apart, the widest 7h25m), and filling a decision against a market
   * seven hours later is not a batcher delay — it is a different market (finding C3).
   */
  maxGapMs: number;
  costOverrides?: Partial<Pick<VenueCosts, 'batcherFeeLovelace' | 'networkFeeLovelace'>>;
}

const SCALE = 10n ** BigInt(PRICE_SCALE);
const SYNTHETIC_FEE_BPS = 30;
/** bps carried to three extra places in bigint, so the final rounding is the only rounding. */
const BPS_SUBUNITS = 1_000n;

/** ADA per whole token from a lovelace/base amount pair, 18 places. */
function priceFromAmounts(lovelace: bigint, base: bigint, decimals: number): Decimal {
  return formatScaled((lovelace * 10n ** BigInt(decimals) * SCALE) / (base * 1_000_000n));
}

/**
 * (fill / reference - 1) in bps for a buy, (1 - fill / reference) for a sell — so both sides report a
 * worse-than-reference execution as a positive number. All bigint: `Number(reserve)/Number(reserve)`
 * loses precision exactly where the reserves are large, which is every real pool.
 */
function deviationBps(fillScaled: bigint, referenceScaled: bigint, isBuy: boolean): number {
  const diff = isBuy ? fillScaled - referenceScaled : referenceScaled - fillScaled;
  return Math.round(Number((diff * 10_000n * BPS_SUBUNITS) / referenceScaled) / Number(BPS_SUBUNITS));
}

export class SimExecutor implements Executor {
  constructor(private readonly o: SimExecutorOptions) {}

  fill(intent: Intent, at: Candle, next: Candle, portfolio: Readonly<Portfolio>): FillResult {
    const gapMs = next.tickTs.getTime() - at.tickTs.getTime();
    if (gapMs > this.o.maxGapMs) return { status: 'rejected', reason: `stale t+1 (gap ${Math.round(gapMs / 60_000)}m)` };
    const pool = this.resolvePool(next);
    if ('reason' in pool) return { status: 'rejected', reason: pool.reason };
    const costs = pool.poolId === 'synthetic'
      ? { ...DEFAULT_COSTS, ...this.o.costOverrides }
      : tryCostsForPoolId(pool.poolId, this.o.costOverrides);
    if (!costs) return { status: 'rejected', reason: `unknown venue ${venueOf(pool.poolId)}` };
    // Spec §4.5: slippage is measured against the mid at t — the price the strategy actually saw
    // when it decided. Measuring it against the t+1 pool instead (what this used to do) hides the
    // move between the two candles inside a number labelled "slippage" (finding C2).
    const midScaled = decimalToScaled(at.close);
    if (midScaled <= 0n) return { status: 'rejected', reason: 'no mid price at t' };
    const lovelaceFees = costs.batcherFeeLovelace + costs.networkFeeLovelace;
    const isBuy = intent.side === 'buy';
    if (isBuy && portfolio.cashLovelace < intent.amountIn + lovelaceFees) return { status: 'rejected', reason: 'insufficient cash' };
    if (!isBuy && portfolio.positionBase < intent.amountIn) return { status: 'rejected', reason: 'insufficient position' };
    const reserveIn = isBuy ? pool.reserveQuote : pool.reserveBase;
    const reserveOut = isBuy ? pool.reserveBase : pool.reserveQuote;
    const amountOut = cpmmAmountOut(intent.amountIn, reserveIn, reserveOut, pool.feeBps);
    if (amountOut <= 0n) return { status: 'rejected', reason: 'dust' };
    if (!isBuy && portfolio.cashLovelace + amountOut < lovelaceFees) return { status: 'rejected', reason: 'insufficient cash' };
    const fillPrice = isBuy ? priceFromAmounts(intent.amountIn, amountOut, this.o.decimals) : priceFromAmounts(amountOut, intent.amountIn, this.o.decimals);
    const fillScaled = decimalToScaled(fillPrice);
    // The t+1 pool's own mid: how much of the fill was this trade moving THIS pool, as opposed to
    // the market moving between t and t+1. Reported separately, never folded into slippage.
    const poolMidScaled = decimalToScaled(priceAdaPerToken(pool.reserveQuote, pool.reserveBase, this.o.decimals));
    return {
      status: 'filled', poolId: pool.poolId,
      unitIn: isBuy ? 'lovelace' : this.o.baseUnit, amountIn: intent.amountIn,
      unitOut: isBuy ? this.o.baseUnit : 'lovelace', amountOut,
      midPrice: at.close, fillPrice,
      poolFeeIn: poolFeeTaken(intent.amountIn, pool.feeBps),
      batcherFeeLovelace: costs.batcherFeeLovelace, networkFeeLovelace: costs.networkFeeLovelace,
      slippageBps: deviationBps(fillScaled, midScaled, isBuy),
      priceImpactBps: deviationBps(fillScaled, poolMidScaled, isBuy),
      tsFill: next.tickTs,
    };
  }

  private resolvePool(next: Candle): { poolId: string; reserveBase: bigint; reserveQuote: bigint; feeBps: number } | { reason: string } {
    if (this.o.fillModel.kind === 'cpmm_observed') {
      // One pool-type check, not two: a null pool_type used to fall past the first and be reported
      // as "no reserves at t+1", naming the wrong thing (finding M2).
      if (next.poolType !== 'cpmm') return { reason: `pool_type ${String(next.poolType)} not cpmm` };
      if (!next.poolId) return { reason: 'no pool at t+1' };
      if (next.closeReserveBase === null || next.closeReserveQuote === null || next.closeReserveBase <= 0n || next.closeReserveQuote <= 0n || next.feeBps === null) {
        return { reason: 'no reserves at t+1' };
      }
      return { poolId: next.poolId, reserveBase: next.closeReserveBase, reserveQuote: next.closeReserveQuote, feeBps: next.feeBps };
    }
    const depth = this.o.fillModel.depthLovelace;
    if (depth <= 0n) return { reason: 'synthetic depth must be positive' };
    const p = decimalToScaled(next.close);
    if (p <= 0n) return { reason: 'no price at t+1' };
    const reserveBase = (depth * 10n ** BigInt(this.o.decimals) * SCALE) / (p * 1_000_000n);
    if (reserveBase <= 0n) return { reason: 'synthetic depth too small for price' };
    return { poolId: next.poolId ?? 'synthetic', reserveBase, reserveQuote: depth, feeBps: next.feeBps ?? SYNTHETIC_FEE_BPS };
  }
}
