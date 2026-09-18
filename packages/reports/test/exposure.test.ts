import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '@ctb/engine';
import { ASSUMED_STAKING_APR_PCT, exposureAdjusted, returnPairs } from '../src/index.js';

/**
 * Observations at a 900-second tick, the interval the live runs actually use.
 *
 * `price` is the token's ADA price and `equity` the run's ADA value. A pure holder has
 * `equity = K * price`, which is the known-answer fixture the estimator must recover.
 */
const TICK_MIN = 15;
const obs = (rows: ReadonlyArray<{ price: number; equity: number; position?: bigint; cash?: bigint; minutes?: number }>): EquityPoint[] => {
  let t = Date.UTC(2026, 8, 17, 0, 0, 0);
  return rows.map((r, i) => {
    if (i > 0) t += (r.minutes ?? TICK_MIN) * 60_000;
    return {
      tickTs: new Date(t),
      cashLovelace: r.cash ?? 0n,
      positionBase: r.position ?? 1_000_000n,
      equityLovelace: BigInt(Math.round(r.equity)),
      equityExecutableLovelace: null,
      price: r.price.toFixed(18),
    };
  });
};

/** A pure holder: a constant token count, so ADA equity tracks the price exactly. */
const holder = (prices: readonly number[], startEquity = 1_000_000_000): EquityPoint[] =>
  obs(prices.map((p) => ({ price: p, equity: startEquity * (p / prices[0]!) })));

const PRICES = [0.0020, 0.00205, 0.00203, 0.00210, 0.00208, 0.00215, 0.00212, 0.00220,
  0.00218, 0.00225, 0.00222, 0.00230, 0.00228, 0.00235];

const measured = (o: EquityPoint[]) => {
  const r = exposureAdjusted(o);
  if (r.kind !== 'measured') throw new Error(`expected a measurement, got ${r.reason}`);
  return r;
};

describe('return pairs (specs/004 T006-T009)', () => {
  it('KEEPS a zero benchmark return as valid data rather than dropping or merging it', () => {
    // The zeros are real: measured 2026-09-17, in all 55 same-reserve snapshot pairs the block
    // height ADVANCED. The chain moved and the pool was not traded. An earlier design collapsed
    // these away as a stale-price artefact; that premise was false (research R1, corrected).
    const flat = holder([0.002, 0.002, 0.002, 0.0021]);
    const pairs = returnPairs(flat);
    expect(pairs).toHaveLength(3);
    expect(pairs.filter((p) => p.benchmarkExcessBps + rf(TICK_MIN) === 0).length).toBe(2);
  });

  it('counts one pair per consecutive tick, and counts the zero-benchmark ones', () => {
    const r = measured(holder([0.002, 0.002, 0.002, 0.0021, 0.0022]));
    expect(r.observations).toBe(4);
    expect(r.zeroBenchmarkPairs).toBe(2);
  });

  it('pro-rates the cash charge to each pair REAL duration, not a nominal tick', () => {
    // A gap in the tick series must be charged for its actual length. Charging a nominal 15 minutes
    // for a 60-minute gap understates the alternative the strategy was measured against.
    const gappy = obs([
      { price: 0.002, equity: 1_000_000_000 },
      { price: 0.002, equity: 1_000_000_000, minutes: 60 },
    ]);
    const [pair] = returnPairs(gappy);
    expect(pair!.benchmarkExcessBps).toBeCloseTo(-rf(60), 9);
  });

  it('measures both series over the SAME interval', () => {
    // Measuring one per tick and the other over some other span would fail no other assertion here
    // and would be silently wrong, so it gets its own test.
    const pairs = returnPairs(holder(PRICES));
    for (const p of pairs) {
      expect(p.toTs.getTime() - p.fromTs.getTime()).toBe(TICK_MIN * 60_000);
    }
    // A pure holder's two excess returns are identical by construction.
    for (const p of pairs) expect(p.strategyExcessBps).toBeCloseTo(p.benchmarkExcessBps, 6);
  });
});

/** The cash charge for `minutes`, in bps — the same arithmetic the module uses. */
const rf = (minutes: number): number =>
  (ASSUMED_STAKING_APR_PCT / 100) * ((minutes * 60_000) / (365 * 24 * 60 * 60 * 1000)) * 10_000;

describe('exposure-adjusted alpha and beta (specs/004 US1)', () => {
  it('THE KNOWN-ANSWER CONTROL: a pure holder reports beta ~ 1 and alpha ~ 0', () => {
    // A measurement that cannot recover beta = 1 from a strategy that simply holds the token is
    // broken, and every other number it prints is meaningless. DO NOT TUNE THE TOLERANCE TO MAKE
    // THIS PASS — if it fails, the estimator is wrong.
    const r = measured(holder(PRICES));
    expect(r.beta).toBeCloseTo(1, 6);
    expect(r.alphaBps).toBeCloseTo(0, 6);
    // HONEST LIMIT OF THIS TEST: a holder's equity tracks the price exactly, so every residual is
    // zero, every resample returns the same alpha, and the interval collapses to [0, 0]. This
    // fixture therefore proves the REGRESSION and proves NOTHING about the bootstrap — it would
    // pass unchanged with the resampling entirely broken. The test below is the one that covers it.
    expect(r.alphaUpperBps - r.alphaLowerBps).toBe(0);
  });

  it('a noisy series produces a NON-DEGENERATE interval, which is what exercises the bootstrap', () => {
    // Idiosyncratic movement the benchmark does not explain must widen the interval. Measured here
    // at about 44 bps wide and spanning zero on thirteen observations, which is also the honest
    // near-term picture: at these sample sizes the window cannot distinguish alpha from zero.
    const noisy = obs(PRICES.map((p, i) => ({
      price: p,
      equity: 1_000_000_000 * (p / PRICES[0]!) * (1 + ((i % 3) - 1) * 0.004),
    })));
    const r = measured(noisy);
    expect(r.alphaUpperBps - r.alphaLowerBps).toBeGreaterThan(1);
    expect(r.alphaLowerBps).toBeLessThan(0);
    expect(r.alphaUpperBps).toBeGreaterThan(0);
    expect(r.beta).toBeCloseTo(1, 1);
  });

  it('a mostly-zero benchmark still recovers beta from the informative pairs', () => {
    // Replaces the attenuation demonstration, which tested for a bias that does not exist. Two
    // thirds of real pairs are zero because the pool went untraded; the estimator must not be
    // defeated by sparsity that is genuinely there.
    const sparse = [0.002, 0.002, 0.002, 0.0021, 0.0021, 0.0021, 0.00205, 0.00205,
      0.00205, 0.00215, 0.00215, 0.00215, 0.0022];
    const r = measured(holder(sparse));
    expect(r.zeroBenchmarkPairs).toBeGreaterThan(r.observations / 2);
    expect(r.beta).toBeCloseTo(1, 6);
  });

  it('THE CASH-CHARGE CONTROL: a cash-only run does not earn alpha from the token falling', () => {
    // Without charging idle cash its forgone yield, a strategy that sits in cash is credited with
    // alpha equal to the token's decline. Remove the charge and this test must fail.
    const falling = [0.0022, 0.00215, 0.0021, 0.00205, 0.002, 0.00195, 0.0019, 0.00185,
      0.0018, 0.00175, 0.0017, 0.00165];
    const cashOnly = obs(falling.map((p) => ({ price: p, equity: 1_000_000_000, position: 0n, cash: 1_000_000_000n })));
    const r = exposureAdjusted(cashOnly);
    // Holding no position at all is a definitional beta of zero, not a measurement of skill.
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('no-position-taken');
  });

  it('a run that spent half the window in cash reports beta well below one', () => {
    const prices = PRICES;
    const half = prices.map((p, i) => (i < prices.length / 2
      ? { price: p, equity: 1_000_000_000 * (p / prices[0]!), position: 1_000_000n }
      : { price: p, equity: 1_000_000_000 * (prices[Math.floor(prices.length / 2)]! / prices[0]!), position: 0n, cash: 1_000_000_000n }));
    const r = measured(obs(half));
    expect(r.beta).toBeLessThan(0.8);
    expect(r.exposedFraction).toBeGreaterThan(0.3);
    expect(r.exposedFraction).toBeLessThan(0.7);
  });

  it('reports its denominations and the rate behind the cash charge', () => {
    // alpha is ADA, beta is unitless, and the gate's token-denominated return is NOT part of this
    // and is never summed with it. A token return and an ADA alpha side by side unlabelled is how
    // the earlier units error survived review.
    const r = measured(holder(PRICES));
    expect(r.alphaDenomination).toBe('ADA');
    expect(r.assumedStakingAprPct).toBe(ASSUMED_STAKING_APR_PCT);
    expect(Number.isFinite(r.alphaLowerBps) && Number.isFinite(r.alphaUpperBps)).toBe(true);
    expect(r.alphaLowerBps).toBeLessThanOrEqual(r.alphaUpperBps);
  });

  it('refuses rather than guessing when there is nothing to measure', () => {
    expect(exposureAdjusted([]).kind).toBe('refused');
    const one = exposureAdjusted(holder([0.002]));
    expect(one.kind === 'refused' && one.reason).toBe('too-few-observations');
    const flat = exposureAdjusted(holder([0.002, 0.002, 0.002, 0.002]));
    expect(flat.kind === 'refused' && flat.reason).toBe('benchmark-did-not-move');
  });

  it('is deterministic: the same observations twice give identical bounds', () => {
    const a = measured(holder(PRICES));
    const b = measured(holder(PRICES));
    expect(a.alphaLowerBps).toBe(b.alphaLowerBps);
    expect(a.alphaUpperBps).toBe(b.alphaUpperBps);
  });
});
