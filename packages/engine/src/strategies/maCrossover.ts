import { crossed, sma } from '../indicators.js';
import type { Intent, Strategy, StrategyContext } from '../types.js';

const MIN_BUY_LOVELACE = 5_000_000n;

/** Plumbing proof: moving-average crossover. Not a recommendation. */
export const maCrossover: Strategy = {
  id: 'ma-crossover',
  defaultParams: { fast: 12, slow: 48, fraction: 0.5 },
  warmup: 49,
  onCandle(ctx: StrategyContext): Intent[] {
    const fast = ctx.params.fast ?? 12;
    const slow = ctx.params.slow ?? 48;
    const fraction = ctx.params.fraction ?? 0.5;
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
