import { decimalToScaled, formatScaled, PRICE_SCALE, priceAdaPerToken, type Decimal } from '@ctb/candles';
import type { Candle, Executor, FillResult, Intent, Portfolio, WorkingPool } from '@ctb/engine';
import { DEFAULT_COSTS, tryCostsForPoolId, venueOf, type VenueCosts } from './costs.js';
import { cpmmAmountOut, poolFeeTaken } from './cpmm.js';

export type FillModel =
  | { kind: 'cpmm_observed' }
  /**
   * `price` picks which candle price the synthetic pool is built at (default `'close'`, matching every
   * existing backtest). `'worst'` is Plan 3's recommendation: a buy is priced at `max(open, close)` and
   * a sell at `min(open, close)`, so the synthetic fill assumes the least favorable side of the candle
   * instead of the close the strategy could not actually have traded at mid-candle.
   */
  | { kind: 'cpmm_synthetic_depth'; depthLovelace: bigint; price?: 'close' | 'worst' };

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
  /**
   * Set only by `paper --rehearsal` (Plan 3 Task 6), to exactly `'Fake'`. `Fake` is not a Dexter
   * venue — `isDexName('Fake')` stays false by design (`packages/collector/src/venues.ts`) — so
   * without this option every fill against a `dev:fake-collector` pool would hit the unknown-venue
   * rejection below and the rehearsal loop could never fill a single order. When a pool's venue
   * equals this string, its costs come from `DEFAULT_COSTS` (assumed) instead of the per-venue
   * table; a real (non-rehearsal) run leaves this unset, so a `Fake` pool is rejected exactly as it
   * always was.
   */
  rehearsalVenue?: string;
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
  // Finding M3: a reference of 0 is not a 0% deviation, it is an unmeasurable one — and dividing by
  // it threw a bigint `RangeError: Division by zero` straight out of `fill`, from inside the engine's
  // settle step, which has no catch: one degenerate pool killed the whole run instead of costing it
  // one order. `midScaled` is already screened by the `no mid price at t` rejection above; the t+1
  // pool's own mid is not, and it floors to 0 whenever a pool's quote reserve is minute against its
  // base reserve. Report 0 and let the fill stand.
  if (referenceScaled <= 0n) return 0;
  const diff = isBuy ? fillScaled - referenceScaled : referenceScaled - fillScaled;
  return Math.round(Number((diff * 10_000n * BPS_SUBUNITS) / referenceScaled) / Number(BPS_SUBUNITS));
}

/** The worse of the two prices for the given side: max(open, close) for a buy, min(open, close) for a sell. */
function worstOf(open: Decimal, close: Decimal, isBuy: boolean): Decimal {
  const o = decimalToScaled(open);
  const cl = decimalToScaled(close);
  return (isBuy ? o >= cl : o <= cl) ? open : close;
}

export class SimExecutor implements Executor {
  constructor(private readonly o: SimExecutorOptions) {}

  fill(intent: Intent, at: Candle, next: Candle, portfolio: Readonly<Portfolio>, working?: WorkingPool): FillResult {
    const gapMs = next.tickTs.getTime() - at.tickTs.getTime();
    if (gapMs > this.o.maxGapMs) return { status: 'rejected', reason: `stale t+1 (gap ${Math.round(gapMs / 60_000)}m)` };
    const isBuy = intent.side === 'buy';
    // `working`, when given, is the poolAfter of an earlier fill decided on this same candle: the
    // second intent in a batch trades against the reserves the first one left behind, not against the
    // same t+1 quote twice (reserve depletion within a candle).
    const pool = working ?? this.resolvePool(next, isBuy);
    if ('reason' in pool) return { status: 'rejected', reason: pool.reason };
    const costs = this.costsFor(pool.poolId);
    if (!costs) return { status: 'rejected', reason: `unknown venue ${venueOf(pool.poolId)}` };
    // Spec §4.5: slippage is measured against the mid at t — the price the strategy actually saw
    // when it decided. Measuring it against the t+1 pool instead (what this used to do) hides the
    // move between the two candles inside a number labelled "slippage" (finding C2).
    const midScaled = decimalToScaled(at.close);
    if (midScaled <= 0n) return { status: 'rejected', reason: 'no mid price at t' };
    const lovelaceFees = costs.batcherFeeLovelace + costs.networkFeeLovelace;
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
    // The whole input enters the pool: a buy adds amountIn to the quote side and removes amountOut
    // from the base side; a sell mirrors that. This is what the NEXT intent in the same candle (if
    // any) trades against, via `working` above — the loop threads it through.
    const poolAfter: WorkingPool = isBuy
      ? { poolId: pool.poolId, reserveQuote: pool.reserveQuote + intent.amountIn, reserveBase: pool.reserveBase - amountOut, feeBps: pool.feeBps }
      : { poolId: pool.poolId, reserveQuote: pool.reserveQuote - amountOut, reserveBase: pool.reserveBase + intent.amountIn, feeBps: pool.feeBps };
    return {
      status: 'filled', poolId: pool.poolId,
      unitIn: isBuy ? 'lovelace' : this.o.baseUnit, amountIn: intent.amountIn,
      unitOut: isBuy ? this.o.baseUnit : 'lovelace', amountOut,
      midPrice: at.close, fillPrice,
      poolFeeIn: poolFeeTaken(intent.amountIn, pool.feeBps),
      batcherFeeLovelace: costs.batcherFeeLovelace, networkFeeLovelace: costs.networkFeeLovelace,
      slippageBps: deviationBps(fillScaled, midScaled, isBuy),
      priceImpactBps: deviationBps(fillScaled, poolMidScaled, isBuy),
      poolAfter,
      tsFill: next.tickTs,
    };
  }

  /**
   * Value the position as a full sell against the candle's OWN reserves (not `next` — there is no
   * fill happening, just a mark), net of the venue's fees. 0 position marks as cash with no pricing
   * needed at all. Never throws: any pricing failure (bad reserves, an unknown venue) is a null point,
   * not a crashed run.
   */
  markToMarket(portfolio: Readonly<Portfolio>, candle: Candle): bigint | null {
    if (portfolio.positionBase <= 0n) return portfolio.cashLovelace;
    try {
      const pool = this.poolAtCandle(candle);
      if (!pool) return null;
      const costs = this.costsFor(pool.poolId);
      if (!costs) return null;
      const proceeds = cpmmAmountOut(portfolio.positionBase, pool.reserveBase, pool.reserveQuote, pool.feeBps);
      return portfolio.cashLovelace + proceeds - costs.batcherFeeLovelace - costs.networkFeeLovelace;
    } catch {
      // intentional: markToMarket must never throw a live paper loop out of its equity tick
      return null;
    }
  }

  /**
   * `'synthetic'` (the `cpmm_synthetic_depth` fill model's own pool id) and `rehearsalVenue` (set
   * only for `paper --rehearsal`, always `'Fake'` today) both cost `DEFAULT_COSTS` — the run has no
   * real venue to look fees up for, so it charges the same assumed default either way. Any other
   * pool id costs whatever `tryCostsForPoolId` returns, `null` (unknown venue) included.
   */
  private costsFor(poolId: string): VenueCosts | null {
    if (poolId === 'synthetic' || (this.o.rehearsalVenue !== undefined && venueOf(poolId) === this.o.rehearsalVenue)) {
      return { ...DEFAULT_COSTS, ...this.o.costOverrides };
    }
    return tryCostsForPoolId(poolId, this.o.costOverrides);
  }

  /** Reserves as this fill model sees THIS candle, for a mark (not a fill against the next one). */
  private poolAtCandle(candle: Candle): WorkingPool | null {
    if (this.o.fillModel.kind === 'cpmm_observed') {
      if (candle.poolType !== 'cpmm' || !candle.poolId) return null;
      if (candle.closeReserveBase === null || candle.closeReserveQuote === null || candle.closeReserveBase <= 0n || candle.closeReserveQuote <= 0n || candle.feeBps === null) {
        return null;
      }
      return { poolId: candle.poolId, reserveBase: candle.closeReserveBase, reserveQuote: candle.closeReserveQuote, feeBps: candle.feeBps };
    }
    const depth = this.o.fillModel.depthLovelace;
    if (depth <= 0n) return null;
    const p = decimalToScaled(candle.close);
    if (p <= 0n) return null;
    const reserveBase = (depth * 10n ** BigInt(this.o.decimals) * SCALE) / (p * 1_000_000n);
    if (reserveBase <= 0n) return null;
    return { poolId: candle.poolId ?? 'synthetic', reserveBase, reserveQuote: depth, feeBps: candle.feeBps ?? SYNTHETIC_FEE_BPS };
  }

  private resolvePool(next: Candle, isBuy: boolean): WorkingPool | { reason: string } {
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
    const { depthLovelace: depth, price: priceMode = 'close' } = this.o.fillModel;
    if (depth <= 0n) return { reason: 'synthetic depth must be positive' };
    const priceDecimal = priceMode === 'worst' ? worstOf(next.open, next.close, isBuy) : next.close;
    const p = decimalToScaled(priceDecimal);
    if (p <= 0n) return { reason: 'no price at t+1' };
    const reserveBase = (depth * 10n ** BigInt(this.o.decimals) * SCALE) / (p * 1_000_000n);
    if (reserveBase <= 0n) return { reason: 'synthetic depth too small for price' };
    return { poolId: next.poolId ?? 'synthetic', reserveBase, reserveQuote: depth, feeBps: next.feeBps ?? SYNTHETIC_FEE_BPS };
  }
}
