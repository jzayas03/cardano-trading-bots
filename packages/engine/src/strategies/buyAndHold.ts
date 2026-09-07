import type { Intent, Strategy, StrategyContext } from '../types.js';
import { cashFraction, MIN_BUY_LOVELACE, requireParam } from './params.js';

const ID = 'buy-and-hold';

/**
 * Baseline, not a strategy anyone would run: buy `fraction` of the cash on the first candle it is
 * allowed to act on and never sell. Every other strategy's numbers over the same window are read
 * against this row — a strategy that trades its way to less than holding did has cost money by
 * trading. If the first buy is rejected (a stale t+1, say) it simply tries again next candle.
 *
 * `fraction` defaults to 0.99, not 1: the executor also charges batcher and network fees in
 * lovelace, which the strategy cannot see, so an all-in buy is `insufficient cash` on every candle
 * forever. At the default the 1% left behind covers 2.2 ADA of fees on any balance of 220 ADA or
 * more (`buyAndHoldFills.test.ts` in the cli package proves it against the real executor).
 */
export const buyAndHold: Strategy = {
  id: ID,
  defaultParams: { fraction: 0.99 },
  warmup: 1,
  warmupFor(params: Record<string, number>): number {
    requireParam(ID, params, 'fraction');
    return 1;
  },
  onCandle(ctx: StrategyContext): Intent[] {
    const fraction = requireParam(ID, ctx.params, 'fraction');
    if (ctx.portfolio.positionBase > 0n) return [];
    const amountIn = cashFraction(ctx.portfolio.cashLovelace, fraction);
    return amountIn >= MIN_BUY_LOVELACE ? [{ side: 'buy', amountIn, reason: 'buy-and-hold entry' }] : [];
  },
};
