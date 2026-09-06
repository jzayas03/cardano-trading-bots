import { crossed, sma } from '../indicators.js';
import type { Intent, Strategy, StrategyContext } from '../types.js';

const MIN_BUY_LOVELACE = 5_000_000n;

/**
 * `params` is always the strategy defaults merged with the run's overrides, so a missing key means
 * the caller built the params object wrong — not that the default applies. `?? 12` silently ran the
 * strategy on numbers nobody chose and reported the result as if they had (finding M8).
 */
function param(params: Record<string, number>, key: string): number {
  const v = params[key];
  if (v === undefined || !Number.isFinite(v)) throw new Error(`ma-crossover: param ${key} is missing or not finite`);
  return v;
}

/** Plumbing proof: moving-average crossover. Not a recommendation. */
export const maCrossover: Strategy = {
  id: 'ma-crossover',
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
      const amountIn = (ctx.portfolio.cashLovelace * BigInt(Math.round(fraction * 10_000))) / 10_000n;
      return amountIn >= MIN_BUY_LOVELACE ? [{ side: 'buy', amountIn, reason: `ma up-cross fast=${fast} slow=${slow}` }] : [];
    }
    if (x === 'down' && ctx.portfolio.positionBase > 0n) {
      return [{ side: 'sell', amountIn: ctx.portfolio.positionBase, reason: `ma down-cross fast=${fast} slow=${slow}` }];
    }
    return [];
  },
};
