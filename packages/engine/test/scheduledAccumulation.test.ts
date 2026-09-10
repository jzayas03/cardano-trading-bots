import { describe, expect, it } from 'vitest';
import { scheduledAccumulation, STRATEGIES, type Candle, type StrategyContext } from '../src/index.js';

const at = (iso: string): Candle => ({
  tickTs: new Date(iso), open: '1', high: '1', low: '1', close: '1', volumeQuote: null,
  poolId: null, poolType: null, feeBps: null, closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null,
});

/** The loop pushes the current candle into `history` before calling `onCandle` (loop.ts:230 vs :249), so the last element of `history` IS `candle`. These contexts are built the same way. */
const ctx = (
  history: Candle[],
  cash: bigint,
  pos = 0n,
  params: Record<string, number> = scheduledAccumulation.defaultParams,
): StrategyContext => ({
  candle: history[history.length - 1]!,
  history,
  closes: history.map(() => 1),
  portfolio: { cashLovelace: cash, positionBase: pos },
  params,
});

const CASH = 10_000_000_000n; // 10,000 ADA — never the binding constraint except where a test says so
const buys = (r: ReturnType<typeof scheduledAccumulation.onCandle>) => r.filter((i) => i.side === 'buy');

describe('scheduledAccumulation', () => {
  it('has the documented defaults and needs one candle of warmup', () => {
    expect(scheduledAccumulation.defaultParams).toEqual({ periodHours: 24, buyAda: 500 });
    expect(scheduledAccumulation.warmup).toBe(1);
    expect(scheduledAccumulation.warmupFor(scheduledAccumulation.defaultParams)).toBe(1);
  });

  it('starts the schedule on the very first candle it sees', () => {
    const r = scheduledAccumulation.onCandle(ctx([at('2026-09-09T13:20:00Z')], CASH));
    expect(r).toEqual([{ side: 'buy', amountIn: 500_000_000n, reason: 'scheduled accumulation: period 2026-09-09T00:00:00.000Z (24h)' }]);
  });

  it('buys once per period, not once per candle', () => {
    const h = [at('2026-09-09T00:05:00Z')];
    expect(buys(scheduledAccumulation.onCandle(ctx(h, CASH)))).toHaveLength(1);
    for (const iso of ['2026-09-09T00:10:00Z', '2026-09-09T06:00:00Z', '2026-09-09T23:55:00Z']) {
      h.push(at(iso));
      expect(scheduledAccumulation.onCandle(ctx(h, CASH))).toEqual([]);
    }
  });

  it('buys again when the calendar period rolls over', () => {
    const h = [at('2026-09-09T23:55:00Z'), at('2026-09-10T00:05:00Z')];
    expect(scheduledAccumulation.onCandle(ctx(h, CASH))).toEqual([
      { side: 'buy', amountIn: 500_000_000n, reason: 'scheduled accumulation: period 2026-09-10T00:00:00.000Z (24h)' },
    ]);
  });

  it('buys ONCE after a multi-period outage, not once for every period missed', () => {
    // The collector was down for three days. A calendar DCA misses those periods; it does not
    // catch up, and it must not fire three orders into one candle to pretend it did.
    const h = [at('2026-09-06T00:05:00Z'), at('2026-09-09T00:05:00Z')];
    const r = scheduledAccumulation.onCandle(ctx(h, CASH));
    expect(r).toHaveLength(1);
    expect(r[0]!.reason).toContain('2026-09-09T00:00:00.000Z');
  });

  it('does not re-buy a period the primed history already covers (a resumed run)', () => {
    // On a resume the loop primes `history` with candles the run already lived through. If the
    // primed candle is in the current period, that period's buy already happened.
    const h = [at('2026-09-09T00:05:00Z'), at('2026-09-09T00:10:00Z')];
    expect(scheduledAccumulation.onCandle(ctx(h, CASH))).toEqual([]);
  });

  it('honours a non-default period', () => {
    const p = { periodHours: 6, buyAda: 150 };
    const same = [at('2026-09-09T00:05:00Z'), at('2026-09-09T05:55:00Z')];
    expect(scheduledAccumulation.onCandle(ctx(same, CASH, 0n, p))).toEqual([]);
    const rolled = [at('2026-09-09T05:55:00Z'), at('2026-09-09T06:05:00Z')];
    expect(scheduledAccumulation.onCandle(ctx(rolled, CASH, 0n, p))).toEqual([
      { side: 'buy', amountIn: 150_000_000n, reason: 'scheduled accumulation: period 2026-09-09T06:00:00.000Z (6h)' },
    ]);
  });

  it('never sells, however large the position', () => {
    const h = [at('2026-09-09T23:55:00Z'), at('2026-09-10T00:05:00Z')];
    const r = scheduledAccumulation.onCandle(ctx(h, CASH, 999_000_000_000n));
    expect(r.every((i) => i.side === 'buy')).toBe(true);
  });

  it('spends what is left when the cash runs short, holding back a flat fee reserve', () => {
    const h = [at('2026-09-10T00:05:00Z')];
    // 200 ADA left against a 500 ADA installment: spend all but the 5 ADA fee reserve. A PERCENTAGE
    // headroom would leave 2 ADA here against a 2.2 ADA fee — rejected, and rejected again every
    // period after, because a schedule always ends up in this regime.
    expect(scheduledAccumulation.onCandle(ctx(h, 200_000_000n))).toEqual([
      { side: 'buy', amountIn: 195_000_000n, reason: 'scheduled accumulation: period 2026-09-10T00:00:00.000Z (24h)' },
    ]);
  });

  it('ends the schedule rather than emit an order the fixed costs would eat', () => {
    const h = [at('2026-09-10T00:05:00Z')];
    // The floor is 100 ADA, derived: below it one leg's fixed cost exceeds the whole round-trip
    // floor. 104.999999 ADA leaves 99.999999 after the reserve — one lovelace short.
    expect(scheduledAccumulation.onCandle(ctx(h, 104_999_999n))).toEqual([]);
    expect(scheduledAccumulation.onCandle(ctx(h, 5_000_000n))).toEqual([]);
    expect(scheduledAccumulation.onCandle(ctx(h, 0n))).toEqual([]);
    // And one lovelace over it clears.
    expect(scheduledAccumulation.onCandle(ctx(h, 105_000_000n))).toHaveLength(1);
  });

  it('throws on an unparseable candle timestamp instead of buying on every candle', () => {
    // NaN !== NaN is TRUE, so a silently-invalid date reads as "every candle is a new period" and
    // turns a daily DCA into a market order per tick. Fail closed, as `opportunity.ts` does.
    const bad = at('not-a-date');
    expect(() => scheduledAccumulation.onCandle(ctx([bad], CASH))).toThrow(/tickTs/);
  });

  it('fails closed on a missing or nonsensical param', () => {
    const h = [at('2026-09-10T00:05:00Z')];
    expect(() => scheduledAccumulation.warmupFor({})).toThrow(/scheduled-accumulation: param periodHours/);
    expect(() => scheduledAccumulation.warmupFor({ periodHours: 24 })).toThrow(/param buyAda/);
    expect(() => scheduledAccumulation.onCandle(ctx(h, CASH, 0n, {}))).toThrow(/periodHours/);
    expect(() => scheduledAccumulation.warmupFor({ periodHours: 0, buyAda: 100 })).toThrow(/periodHours/);
    expect(() => scheduledAccumulation.warmupFor({ periodHours: -1, buyAda: 100 })).toThrow(/periodHours/);
    expect(() => scheduledAccumulation.warmupFor({ periodHours: 24, buyAda: 0 })).toThrow(/buyAda/);
  });

  it('is registered under its id', () => {
    // `toBe` alone passes vacuously while the module does not exist yet — undefined === undefined.
    // The `toBeDefined` and the literal id are what make this assertion capable of failing.
    expect(STRATEGIES['scheduled-accumulation']).toBeDefined();
    expect(STRATEGIES['scheduled-accumulation']).toBe(scheduledAccumulation);
    expect(scheduledAccumulation.id).toBe('scheduled-accumulation');
  });
});
