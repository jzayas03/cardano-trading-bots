import type { Candle, Intent, Strategy, StrategyContext } from '../types.js';
import { MIN_BUY_LOVELACE, requireParam } from './params.js';

const ID = 'scheduled-accumulation';
const MS_PER_HOUR = 3_600_000;

/**
 * Held back from the LAST, partial installment to cover the batcher and network fees the strategy
 * sizes orders without seeing — an order for the entire remaining balance is `insufficient cash`
 * forever.
 *
 * A FIXED reserve, not `buyAndHold`'s 1% of balance, because the two strategies fail differently.
 * `buyAndHold` spends once at full balance, where 1% covers the 2.2 ADA fee on any balance over 220
 * ADA. A schedule always runs its balance DOWN to a remainder, so it ends up in exactly the regime
 * where a percentage stops covering a constant: at 45 ADA left, 1% is 0.45 ADA against a 2.2 ADA
 * fee, and the final installment would be rejected — and then rejected again every period after,
 * forever, since nothing about the balance changes. A constant terminates the schedule cleanly.
 *
 * 5 ADA against a measured 2.2 (MinswapV2: 2.0 batcher + 0.2 network) leaves room for the dearer
 * venues — SundaeSwapV3 quoted 1.28 ADA protocol plus a 2.00 ADA deposit during the M6.1 spike.
 */
const FEE_RESERVE_LOVELACE = 5_000_000n;

function periodMs(params: Record<string, number>): number {
  const hours = requireParam(ID, params, 'periodHours');
  if (hours <= 0) throw new Error(`${ID}: param periodHours must be positive, got ${hours}`);
  return hours * MS_PER_HOUR;
}

function buyLovelace(params: Record<string, number>): bigint {
  const ada = requireParam(ID, params, 'buyAda');
  if (ada <= 0) throw new Error(`${ID}: param buyAda must be positive, got ${ada}`);
  return BigInt(Math.round(ada * 1_000_000));
}

/**
 * An unparseable date is the one input that turns this strategy inside out. Every decision below is
 * `floor(t / periodMs) !== floor(prev / periodMs)`, and `NaN !== NaN` is TRUE — so a single invalid
 * `tickTs` reads as "every candle begins a new period" and a daily DCA becomes a market order per
 * tick, silently, with plausible-looking orders. Fail closed, exactly as `reports/opportunity.ts`
 * does for the same reason.
 */
function tickMs(candle: Candle): number {
  const t = candle.tickTs.getTime();
  if (!Number.isFinite(t)) throw new Error(`${ID}: candle tickTs is not a valid date; an unparseable timestamp silently buys on every candle`);
  return t;
}

/**
 * The most recent candle strictly BEFORE `nowMs`. Scanned rather than taken as `history[len - 2]`
 * so it does not depend on whether the caller put the current candle in `history` — the loop does
 * (loop.ts pushes at :230 and calls `onCandle` at :249), but a strategy that silently misreads a
 * different history shape would just buy twice. Candles with an unreadable timestamp are skipped:
 * they cannot establish which period we were in.
 */
function previousTickMs(history: readonly Candle[], nowMs: number): number | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]!.tickTs.getTime();
    if (Number.isFinite(t) && t < nowMs) return t;
  }
  return null;
}

/**
 * Calendar dollar-cost averaging: buy `buyAda` worth of the base token once per `periodHours`, and
 * never sell. The zero-edge baseline named in `docs/ops/2026-09-09-strategy-state.md` — "convert ADA
 * to NIGHT on a calendar, pay one one-way fee, require no signal" — and the benchmark every
 * signal-driven strategy has to beat before its signal has been shown to be worth anything.
 *
 * **It is handicapped on fees by construction, and that is the point.** `buy-and-hold` pays the
 * ~2.20 ADA batcher + network cost ONCE; a daily schedule over a week pays it seven times. So this
 * strategy can only beat holding on average ENTRY PRICE, spotting it that handicap — which is the
 * comparison worth having.
 *
 * **Installment size is therefore the parameter that matters most, and the original default was
 * wrong by 10x in the comment that justified it.** The fixed cost as a fraction of the order is
 * `2.20 / buyAda`:
 *
 *     buyAda    fixed cost, one way
 *      25 ADA           880 bps
 *     100 ADA           220 bps   <- the old default; MORE than the whole 216 bps round-trip floor
 *     500 ADA            44 bps   <- the default now
 *    1000 ADA            22 bps
 *
 * The old comment claimed 22 bps at 100 ADA. That figure was correct for run 139's 990 ADA fill and
 * was carried across without redividing. At 100 ADA a single installment's fixed cost exceeds the
 * entire measured round-trip floor, which makes the schedule a donation rather than a benchmark.
 * Raising `buyAda` dilutes the fixed cost and raises price impact; lowering it does the reverse.
 *
 * **The schedule is a wall clock, not a candle count.** Periods are `floor(tickTs / periodHours)`
 * since the epoch, which for any divisor of 24h lands on UTC boundaries. Deriving the period from
 * the timestamp rather than counting candles is what makes it a *calendar* DCA: the collector's
 * history is sparse (561 of 4968 consecutive SNEK pairs are over an hour apart), and a
 * count-based schedule drifts by exactly the missing candles while claiming it did not.
 *
 * Two consequences of holding no state, both deliberate:
 *
 * - **A missed period is missed, not caught up.** Three days of outage produce ONE buy on the next
 *   candle, not three. A calendar DCA whose exchange was down on the 1st does not buy twice on the
 *   2nd, and firing three orders into one candle would be a burst of price impact the schedule
 *   exists to avoid.
 * - **The schedule ENDS when the cash does**, at a remainder under `MIN_BUY_LOVELACE` + the fee
 *   reserve, rather than emitting orders that can no longer be filled.
 * - **A REJECTED buy skips that period** rather than retrying next candle, because the strategy
 *   cannot see fills — `StrategyContext` carries the portfolio, not the order book, so a retry
 *   could not tell "rejected" from "already bought". The period is written into the order's
 *   `reason`, so a gap in the sequence is visible in `paper_orders` instead of silent. `buyAndHold`
 *   can retry only because its whole condition is `positionBase === 0n`.
 *
 * A resumed run is safe on both counts: the loop primes `history` with candles the run already
 * lived through, so the period they fall in is known and is not bought a second time.
 */
export const scheduledAccumulation: Strategy = {
  id: ID,
  defaultParams: { periodHours: 24, buyAda: 500 },
  warmup: 1,
  warmupFor(params: Record<string, number>): number {
    // Validated here as well as in `onCandle` so a misconfigured run dies at startup rather than on
    // its first candle, hours later, having reported itself healthy in between.
    periodMs(params);
    buyLovelace(params);
    return 1;
  },
  onCandle(ctx: StrategyContext): Intent[] {
    const span = periodMs(ctx.params);
    const installment = buyLovelace(ctx.params);
    const nowMs = tickMs(ctx.candle);
    const period = Math.floor(nowMs / span);

    const prevMs = previousTickMs(ctx.history, nowMs);
    if (prevMs !== null && Math.floor(prevMs / span) === period) return [];

    const affordable = ctx.portfolio.cashLovelace - FEE_RESERVE_LOVELACE;
    const amountIn = installment < affordable ? installment : affordable;
    if (amountIn < MIN_BUY_LOVELACE) return [];

    const startedAt = new Date(period * span).toISOString();
    return [{ side: 'buy', amountIn, reason: `scheduled accumulation: period ${startedAt} (${requireParam(ID, ctx.params, 'periodHours')}h)` }];
  },
};
