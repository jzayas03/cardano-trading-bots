import { crossed, sma } from '../indicators.js';
import type { Intent, Strategy, StrategyContext } from '../types.js';
import { cashFraction, MIN_BUY_LOVELACE, requireParam } from './params.js';

const ID = 'ma-crossover';
const param = (params: Record<string, number>, key: string): number => requireParam(ID, params, key);

/** Plumbing proof: moving-average crossover. Not a recommendation. */
export const maCrossover: Strategy = {
  id: ID,
  defaultParams: { fast: 12, slow: 48, fraction: 0.5 },
  warmup: 49,
  // The slow SMA needs `slow` closes, and a cross needs one more candle to have a "before" to
  // compare against — so slow + 1, computed from the params actually in force (finding I5).
  warmupFor(params: Record<string, number>): number {
    return param(params, 'slow') + 1;
  },
  onCandle(ctx: StrategyContext): Intent[] {
    const fast = param(ctx.params, 'fast');
    const slow = param(ctx.params, 'slow');
    const fraction = param(ctx.params, 'fraction');
    const now = ctx.closes;
    const prev = now.slice(0, -1);
    const fNow = sma(now, fast); const sNow = sma(now, slow);
    const fPrev = sma(prev, fast); const sPrev = sma(prev, slow);
    if (fNow === null || sNow === null || fPrev === null || sPrev === null) return [];
    const x = crossed(fPrev, sPrev, fNow, sNow);
    if (x === 'up' && ctx.portfolio.positionBase === 0n) {
      const amountIn = cashFraction(ctx.portfolio.cashLovelace, fraction);
      return amountIn >= MIN_BUY_LOVELACE ? [{ side: 'buy', amountIn, reason: `ma up-cross fast=${fast} slow=${slow}` }] : [];
    }
    if (x === 'down' && ctx.portfolio.positionBase > 0n) {
      return [{ side: 'sell', amountIn: ctx.portfolio.positionBase, reason: `ma down-cross fast=${fast} slow=${slow}` }];
    }
    return [];
  },
};
