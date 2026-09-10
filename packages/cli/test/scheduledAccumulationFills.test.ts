import { describe, expect, it } from 'vitest';
import { buyAndHold, runEngine, scheduledAccumulation, type Candle } from '@ctb/engine';
import { SimExecutor } from '@ctb/sim-executor';

const log = { info: () => {}, warn: () => {}, error: () => {} };
/** Hourly candles from 2026-09-06T00:00Z, so a 24h schedule rolls over every 24th one. */
const c = (hour: number, close = '0.002'): Candle => ({
  tickTs: new Date(Date.UTC(2026, 8, 6, hour)), open: close, high: close, low: close, close, volumeQuote: '1',
  poolId: null, poolType: null, feeBps: null, closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null,
});
const feed = (hours: number): Candle[] => Array.from({ length: hours }, (_, i) => c(i));
const executor = () => new SimExecutor({ decimals: 0, baseUnit: 'tok', fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: 800_000_000_000n }, maxGapMs: 7_200_000 });

/**
 * The unit tests prove which intents the schedule emits. These prove the intents are ones the real
 * executor will FILL — the failure they exist for is a strategy that emits perfectly-reasoned orders
 * and gets `insufficient cash` on every one, which reads as a clean 0% (`buyAndHoldFills.test.ts`,
 * where that exact thing happened for 4,969 candles).
 */
describe('scheduled-accumulation fills at its default params against the real executor', () => {
  it('fills one installment per calendar day and holds every one', async () => {
    // 74 hourly candles = periods starting at hours 0, 24, 48 and 72, and one spare candle so the
    // last decision has a t+1 to settle against.
    const r = await runEngine({ feed: feed(74), strategy: scheduledAccumulation, executor: executor(),
      initial: { cashLovelace: 5_000_000_000n, positionBase: 0n }, decimals: 0, log });
    expect(r.summary.intents).toBe(4);
    expect(r.summary.filled).toBe(4);
    expect(r.summary.rejected).toBe(0);
    expect(r.summary.warnings).toEqual([]);
    // 5000 ADA - 4 installments of 500 - 4 x 2.2 ADA of fees. The fee multiplication is the point.
    expect(r.summary.feesLovelace).toBe('8800000');
    expect(r.final.cashLovelace).toBe(5_000_000_000n - 2_000_000_000n - 8_800_000n);
    expect(r.final.positionBase).toBeGreaterThan(0n);
  });

  it('pays the fixed cost once per installment where buy-and-hold pays it once, on the same feed', async () => {
    // The handicap, measured rather than asserted in prose: at a FLAT price the two differ by
    // nothing except how many times they paid the batcher. Four installments, four times the fee.
    const sched = await runEngine({ feed: feed(74), strategy: scheduledAccumulation, executor: executor(),
      initial: { cashLovelace: 5_000_000_000n, positionBase: 0n }, decimals: 0, log });
    const hold = await runEngine({ feed: feed(74), strategy: buyAndHold, executor: executor(),
      initial: { cashLovelace: 5_000_000_000n, positionBase: 0n }, decimals: 0, log });
    expect(hold.summary.filled).toBe(1);
    expect(BigInt(sched.summary.feesLovelace)).toBe(4n * BigInt(hold.summary.feesLovelace));
  });

  it('ends the schedule when the cash runs out instead of rejecting an unfillable order forever', async () => {
    // The regime a schedule ALWAYS reaches and buy-and-hold never does. A percentage-of-balance
    // headroom breaks here: at 45.6 ADA left it sizes 45.14, the executor needs 47.34, and the
    // order is rejected — which leaves the balance unchanged, so the next period sizes exactly the
    // same too-large order, and every period after that. `rejected: 0` is what pins the fix.
    const r = await runEngine({ feed: feed(121), strategy: scheduledAccumulation, executor: executor(),
      initial: { cashLovelace: 1_200_000_000n, positionBase: 0n }, decimals: 0, log });
    expect(r.summary.filled).toBe(3); // 500, 500, then the 190.6 remainder
    expect(r.summary.rejected).toBe(0);
    expect(r.summary.intents).toBe(3); // and NOT one per period for the rest of the feed
    expect(r.summary.warnings).toEqual([]);
    expect(r.final.cashLovelace).toBe(2_800_000n); // under the reserve: the schedule is over
  });

  it('a shorter period buys more often on the same feed', async () => {
    const r = await runEngine({ feed: feed(74), strategy: scheduledAccumulation, params: { periodHours: 6, buyAda: 150 }, executor: executor(),
      initial: { cashLovelace: 5_000_000_000n, positionBase: 0n }, decimals: 0, log });
    expect(r.summary.filled).toBe(13); // hours 0,6,12,...,72
    expect(r.summary.rejected).toBe(0);
  });
});
