import { describe, expect, it } from 'vitest';
import type { OrderRecord } from '@ctb/engine';
import { roundTripStats, roundTrips } from '../src/index.js';

let seq = 0;
const buy = (lovelaceIn: bigint, baseOut: bigint, fees = 2_200_000n): OrderRecord => ({
  seq: ++seq, tsIntent: new Date(Date.UTC(2026, 8, 6, seq)),
  intent: { side: 'buy', amountIn: lovelaceIn, reason: 'x' },
  result: {
    status: 'filled', poolId: 'p', unitIn: 'lovelace', amountIn: lovelaceIn, unitOut: 'tok', amountOut: baseOut,
    midPrice: '1', fillPrice: '1', poolFeeIn: 0n, batcherFeeLovelace: fees - 200_000n, networkFeeLovelace: 200_000n,
    slippageBps: 0, priceImpactBps: 0, poolAfter: null, tsFill: new Date(Date.UTC(2026, 8, 6, seq)),
  },
});
const sell = (baseIn: bigint, lovelaceOut: bigint, fees = 2_200_000n): OrderRecord => ({
  seq: ++seq, tsIntent: new Date(Date.UTC(2026, 8, 6, seq)),
  intent: { side: 'sell', amountIn: baseIn, reason: 'x' },
  result: {
    status: 'filled', poolId: 'p', unitIn: 'tok', amountIn: baseIn, unitOut: 'lovelace', amountOut: lovelaceOut,
    midPrice: '1', fillPrice: '1', poolFeeIn: 0n, batcherFeeLovelace: fees - 200_000n, networkFeeLovelace: 200_000n,
    slippageBps: 0, priceImpactBps: 0, poolAfter: null, tsFill: new Date(Date.UTC(2026, 8, 6, seq)),
  },
});
const rejected = (): OrderRecord => ({
  seq: ++seq, tsIntent: new Date(0), intent: { side: 'buy', amountIn: 1n, reason: 'x' },
  result: { status: 'rejected', reason: 'dust' },
});

describe('round-trip pairing', () => {
  it('pairs one buy to one sell, net of the fees on BOTH legs', () => {
    seq = 0;
    // 100 ADA in + 2.2 fees = 102.2 cost. Sold for 110 ADA - 2.2 fees = 107.8 proceeds.
    const [t] = roundTrips([buy(100_000_000n, 1_000n), sell(1_000n, 110_000_000n)]);
    expect(t!.costLovelace).toBe(102_200_000n);
    expect(t!.proceedsLovelace).toBe(107_800_000n);
    expect(t!.returnBps).toBeCloseTo(548.0, 0); // (107.8/102.2 - 1) * 10000
    expect(t!.baseUnits).toBe(1_000n);
  });

  it('is FIFO: the oldest lot closes first', () => {
    seq = 0;
    const trips = roundTrips([buy(100_000_000n, 1_000n), buy(200_000_000n, 1_000n), sell(1_000n, 150_000_000n)]);
    expect(trips).toHaveLength(1);
    // The 100 ADA lot closed, not the 200 ADA one — cost 102.2, not 202.2.
    expect(trips[0]!.costLovelace).toBe(102_200_000n);
    expect(trips[0]!.openSeq).toBe(1);
  });

  it('splits a lot across a partial close and keeps the remainder open', () => {
    seq = 0;
    const orders = [buy(100_000_000n, 1_000n), sell(400n, 44_000_000n)];
    const trips = roundTrips(orders);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.baseUnits).toBe(400n);
    // 40% of the lot: 40% of its 102.2 cost.
    expect(trips[0]!.costLovelace).toBe(40_880_000n);
    expect(roundTripStats(orders, trips).openLots).toBe(1);
  });

  it('lets one sell consume two lots, producing two round trips', () => {
    seq = 0;
    const trips = roundTrips([buy(100_000_000n, 1_000n), buy(100_000_000n, 1_000n), sell(2_000n, 220_000_000n)]);
    expect(trips).toHaveLength(2);
    expect(trips.map((t) => t.openSeq)).toEqual([1, 2]);
    // Proceeds split pro rata by base units: half each of (220 - 2.2).
    expect(trips[0]!.proceedsLovelace).toBe(108_900_000n);
    expect(trips[1]!.proceedsLovelace).toBe(108_900_000n);
  });

  it('counts a sell with nothing open instead of crashing or inventing a trip', () => {
    seq = 0;
    const orders = [sell(1_000n, 100_000_000n)];
    expect(roundTrips(orders)).toEqual([]);
    expect(roundTripStats(orders, roundTrips(orders)).unmatchedSells).toBe(1);
  });

  it('ignores rejected orders entirely', () => {
    seq = 0;
    expect(roundTrips([rejected(), buy(100_000_000n, 1_000n), rejected(), sell(1_000n, 110_000_000n)])).toHaveLength(1);
  });

  it('records how long each position was held', () => {
    seq = 0;
    const [t] = roundTrips([buy(100_000_000n, 1_000n), sell(1_000n, 110_000_000n)]);
    expect(t!.holdMs).toBe(3_600_000); // consecutive hourly fixtures
  });
});

describe('round-trip statistics', () => {
  /** n round trips whose returns are exactly `bps`, built as buys and sells that produce them. */
  const withReturns = (bpsList: number[]): OrderRecord[] => {
    seq = 0;
    const out: OrderRecord[] = [];
    for (const bps of bpsList) {
      const cost = 102_200_000n; // 100 ADA + 2.2 fees
      const proceeds = (cost * BigInt(Math.round(10_000 + bps))) / 10_000n;
      out.push(buy(100_000_000n, 1_000n), sell(1_000n, proceeds + 2_200_000n));
    }
    return out;
  };

  it('reports the median, mean and sample standard deviation of the returns', () => {
    const orders = withReturns([-100, 0, 100]);
    const s = roundTripStats(orders, roundTrips(orders));
    expect(s.trips).toBe(3);
    expect(s.medianReturnBps).toBeCloseTo(0, 0);
    expect(s.meanReturnBps).toBeCloseTo(0, 0);
    expect(s.stdevBps).toBeCloseTo(100, 0);
  });

  it('exposes the normality assumption the n=30 threshold rests on, so it can be checked', () => {
    // The promotion gate converted median|X| into σ with median|X| ≈ 0.674σ, which holds ONLY for a
    // normal distribution. This field recomputes that implied σ so it can be read against the
    // measured one: if they disagree, the conversion behind n=30 does not hold.
    const orders = withReturns([-100, -50, 50, 100]);
    const s = roundTripStats(orders, roundTrips(orders));
    expect(s.medianAbsReturnBps).toBeCloseTo(75, 0);
    expect(s.normalImpliedStdevBps).toBeCloseTo(75 / 0.6745, 0);
    expect(s.stdevBps).not.toBeNull();
  });

  it('measures excess kurtosis, which is SCALE-FREE and so survives the wrong denominator', () => {
    // Why this field exists: the only corpora with enough round trips today are backtests over
    // external, USD-denominated candles, so any σ from them is in the wrong currency. Kurtosis is
    // dimensionless, so the fat-tail question can be answered from data whose SCALE cannot be quoted.
    const flat = withReturns([-100, -100, 100, 100]); // platykurtic, well under 0
    expect(roundTripStats(flat, roundTrips(flat)).excessKurtosis!).toBeLessThan(0);
    const fat = withReturns([-5, -3, -1, 0, 1, 3, 5, -400, 400]); // heavy tails
    expect(roundTripStats(fat, roundTrips(fat)).excessKurtosis!).toBeGreaterThan(0);
  });

  it('is null, never 0, when there are too few trips to compute a moment', () => {
    const one = withReturns([50]);
    const s = roundTripStats(one, roundTrips(one));
    expect(s.stdevBps).toBeNull();       // needs 2
    expect(s.excessKurtosis).toBeNull(); // needs 4
    expect(s.medianReturnBps).not.toBeNull();
    const none = roundTripStats([], []);
    expect(none.medianReturnBps).toBeNull();
    expect(none.trips).toBe(0);
  });
});
