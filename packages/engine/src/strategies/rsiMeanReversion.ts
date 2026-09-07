import { rsi } from '../indicators.js';
import type { Intent, Strategy, StrategyContext } from '../types.js';
import { cashFraction, MIN_BUY_LOVELACE, requireParam } from './params.js';

const ID = 'rsi-mean-reversion';

/**
 * Plumbing proof: RSI mean reversion. Not a recommendation.
 *
 * Buys when RSI crosses back UP through `buyBelow` (it was oversold and has started to recover),
 * sells the whole position when RSI crosses back DOWN through `sellAbove`. Cross-back rather than
 * raw threshold: "RSI < 30" is true on every candle of a falling market, and a strategy that buys
 * on each of them is a buyer of every dip on the way down.
 */
export const rsiMeanReversion: Strategy = {
  id: ID,
  defaultParams: { period: 14, buyBelow: 30, sellAbove: 70, fraction: 0.5 },
  warmup: 16,
  // rsi() needs period + 1 closes; the cross-back needs one more so there is a "before" to compare.
  warmupFor(params: Record<string, number>): number {
    return requireParam(ID, params, 'period') + 2;
  },
  onCandle(ctx: StrategyContext): Intent[] {
    const period = requireParam(ID, ctx.params, 'period');
    const buyBelow = requireParam(ID, ctx.params, 'buyBelow');
    const sellAbove = requireParam(ID, ctx.params, 'sellAbove');
    const fraction = requireParam(ID, ctx.params, 'fraction');
    const now = rsi(ctx.closes, period);
    const prev = rsi(ctx.closes.slice(0, -1), period);
    if (now === null || prev === null) return [];
    if (prev < buyBelow && now >= buyBelow && ctx.portfolio.positionBase === 0n) {
      const amountIn = cashFraction(ctx.portfolio.cashLovelace, fraction);
      return amountIn >= MIN_BUY_LOVELACE ? [{ side: 'buy', amountIn, reason: `rsi back above ${buyBelow} (${prev.toFixed(1)} -> ${now.toFixed(1)}) period=${period}` }] : [];
    }
    if (prev > sellAbove && now <= sellAbove && ctx.portfolio.positionBase > 0n) {
      return [{ side: 'sell', amountIn: ctx.portfolio.positionBase, reason: `rsi back below ${sellAbove} (${prev.toFixed(1)} -> ${now.toFixed(1)}) period=${period}` }];
    }
    return [];
  },
};
