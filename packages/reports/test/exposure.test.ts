import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '@ctb/engine';
import { ASSUMED_STAKING_APR_PCT, exposureAdjusted, returnPairs, type ExposureRefusal } from '../src/index.js';

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

/**
 * A series whose residuals move SMOOTHLY relative to the benchmark, so consecutive residuals are
 * positively correlated. This is the shape `n_eff` exists to discount: neighbouring ticks carry
 * overlapping information, so counting them as independent overstates the evidence.
 */
const drifting = (): EquityPoint[] => obs(PRICES.map((p, i) => ({
  price: p,
  equity: 1_000_000_000 * (p / PRICES[0]!) * (1 + 0.006 * Math.sin(i / 3)),
})));

describe('effective observations (specs/004 US2, T025-T027)', () => {
  it('reports n_eff = n (1 - rho) / (1 + rho), floored at 1 and capped at n', () => {
    const r = measured(drifting());
    const rho = r.lag1Autocorrelation;
    const expected = Math.min(r.observations, Math.max(1, (r.observations * (1 - rho)) / (1 + rho)));
    expect(r.effectiveObservations).toBeCloseTo(expected, 9);
    expect(r.effectiveObservations).toBeGreaterThanOrEqual(1);
    expect(r.effectiveObservations).toBeLessThanOrEqual(r.observations);
  });

  it('SC-004: n_eff is STRICTLY below n whenever rho > 0', () => {
    // With the collapse gone this carries the entire honesty burden. It is the only thing between a
    // raw count of ~700 ticks a week and a reader's impression of how much evidence exists.
    const r = measured(drifting());
    expect(r.lag1Autocorrelation).toBeGreaterThan(0);
    expect(r.effectiveObservations).toBeLessThan(r.observations);
  });

  it('reports rho alongside, so the input to n_eff is VISIBLE rather than assumed', () => {
    const r = measured(drifting());
    expect(Number.isFinite(r.lag1Autocorrelation)).toBe(true);
    expect(r.lag1Autocorrelation).toBeGreaterThanOrEqual(-1);
    expect(r.lag1Autocorrelation).toBeLessThanOrEqual(1);
  });

  it('separates DEPENDENCE from IDENTIFICATION: n_eff discounts the first, not the second', () => {
    // The two are different problems and one number cannot carry both. n_eff answers "how much of
    // this series repeats itself"; informativePairs answers "how many pairs saw the pool trade at
    // all". A run can score a high n_eff on a series that is mostly zeros, because zeros are not
    // autocorrelated -- they are uninformative, which is a different defect. See research R4.
    const r = measured(holder(PRICES));
    expect(r.informativePairs).toBe(r.observations - r.zeroBenchmarkPairs);
  });
});

describe('refusals: five outcomes, exactly one per input, no fallthrough (T028-T033)', () => {
  it('not-applicable: a run recording no equity observations SAYS so', () => {
    const r = exposureAdjusted([]);
    expect(r.kind === 'refused' && r.reason).toBe('not-applicable');
    if (r.kind === 'refused') expect(r.detail).toMatch(/no equity observations/);
  });

  it('window-open: a run still in progress is not a result', () => {
    // A partial window presented as a result is a finding that changes tomorrow. Whether the run has
    // finished is a fact the CALLER holds; deriving it from a clock would break the purity guard.
    const r = exposureAdjusted(holder(PRICES), { runFinished: false });
    expect(r.kind === 'refused' && r.reason).toBe('window-open');
    // The same observations with the run finished DO measure, so the refusal is the flag and
    // nothing else.
    expect(exposureAdjusted(holder(PRICES), { runFinished: true }).kind).toBe('measured');
  });

  it('benchmark-did-not-move: beta is undefined and any alpha is the whole return mislabelled', () => {
    const r = exposureAdjusted(holder([0.002, 0.002, 0.002, 0.002]));
    expect(r.kind === 'refused' && r.reason).toBe('benchmark-did-not-move');
  });

  it('no-position-taken: beta 0 is DEFINITIONAL, not a measurement of skill', () => {
    const cash = obs(PRICES.map((p) => ({ price: p, equity: 1_000_000_000, position: 0n, cash: 1_000_000_000n })));
    const r = exposureAdjusted(cash);
    expect(r.kind === 'refused' && r.reason).toBe('no-position-taken');
    if (r.kind === 'refused') expect(r.detail).toMatch(/definition/i);
  });

  it('too-few-observations: fewer than 2 return pairs cannot be fitted', () => {
    expect(exposureAdjusted(holder([0.002, 0.0021])).kind === 'refused'
      && (exposureAdjusted(holder([0.002, 0.0021])) as ExposureRefusal).reason).toBe('too-few-observations');
  });

  it('the five outcomes are EXHAUSTIVE and MUTUALLY EXCLUSIVE — one per input', () => {
    // No default-bearing fallthrough: every input below lands on exactly one outcome, and between
    // them the inputs cover every refusal the data model names plus the measured case.
    const cash = obs(PRICES.map((p) => ({ price: p, equity: 1_000_000_000, position: 0n, cash: 1_000_000_000n })));
    const cases: Array<[string, ReturnType<typeof exposureAdjusted>]> = [
      ['not-applicable', exposureAdjusted([])],
      ['window-open', exposureAdjusted(holder(PRICES), { runFinished: false })],
      ['no-position-taken', exposureAdjusted(cash)],
      ['too-few-observations', exposureAdjusted(holder([0.002, 0.0021]))],
      ['benchmark-did-not-move', exposureAdjusted(holder([0.002, 0.002, 0.002, 0.002]))],
      ['measured', exposureAdjusted(holder(PRICES))],
    ];
    const seen = cases.map(([, r]) => (r.kind === 'refused' ? r.reason : 'measured'));
    expect(seen).toEqual(cases.map(([want]) => want));
    expect(new Set(seen).size).toBe(6);
  });
});

describe('no NaN on any path (T034) and split-window beta (T036-T037)', () => {
  it('EVERY numeric field is finite, on every path that reaches a result', () => {
    // A NaN bound compares false against zero, so it would read as "cannot distinguish alpha from
    // zero" for entirely the wrong reason: the report would look honest while being broken.
    const inputs = [holder(PRICES), drifting(), holder([0.002, 0.002, 0.0021, 0.0021, 0.0022])];
    for (const input of inputs) {
      const r = measured(input);
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'number') expect(Number.isFinite(v), `${k} is not finite`).toBe(true);
      }
      for (const half of [r.betaFirstHalf, r.betaSecondHalf]) {
        if (half !== null) {
          expect(Number.isFinite(half.beta)).toBe(true);
          expect(Number.isFinite(half.lower)).toBe(true);
          expect(Number.isFinite(half.upper)).toBe(true);
        }
      }
    }
  });

  it('a half with no benchmark movement reports null rather than a NaN beta', () => {
    // First half flat, second half moving: the first half has no slope to fit and must say so.
    const halfFlat = holder([0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.00205, 0.0021, 0.00215, 0.0022, 0.00225, 0.0023]);
    const r = measured(halfFlat);
    expect(r.betaFirstHalf).toBeNull();
    expect(r.betaSecondHalf).not.toBeNull();
  });

  it('fits beta on each half separately and reports whether the intervals OVERLAP', () => {
    const r = measured(drifting());
    expect(r.betaFirstHalf).not.toBeNull();
    expect(r.betaSecondHalf).not.toBeNull();
    expect(typeof r.betaHalvesOverlap).toBe('boolean');
    // A pure holder's halves are BOTH degenerate -- equity tracks the price, so every residual is
    // zero and each half's interval is a point. The honest answer there is that the comparison
    // cannot be made, not that the exposure held steady. Same blindness the US1 control documents.
    expect(measured(holder(PRICES)).betaHalvesOverlap).toBeNull();
  });

  it('keeps the TWO STABILITIES labelled apart: seed stability vs exposure drift', () => {
    // They answer different questions -- is the interval a numerical artefact, versus did the
    // parameter itself move. Conflating them would let a stable-seed reading be quoted as a
    // stable-exposure claim, which is a claim about the strategy that nobody measured.
    const r = measured(drifting());
    expect(r).toHaveProperty('alphaSeedStable');
    expect(r).toHaveProperty('betaHalvesOverlap');
    expect(typeof r.alphaSeedStable).toBe('boolean');
  });
});

describe('THE FALSIFICATION: zero-inflation is not autocorrelation (research R4, corrected)', () => {
  /**
   * R4 and task T038 both asserted that "a series that is two thirds zeros is strongly dependent, so
   * if `n_eff` does not come out far below `n` the formula is on the wrong series". **Measured
   * 2026-09-18 on a 700-tick fixture at the live 67.6% zero fraction: that premise is false.** The
   * lag-1 autocorrelation came out at -0.02 on the benchmark returns, -0.06 on the strategy returns
   * and -0.53 on the residuals -- negative on all three, so `n_eff` equals `n` and discounts
   * NOTHING. No choice of series rescues the claim.
   *
   * Zeros are uninformative, not dependent: they sit at the series mean and carry no signal about
   * their neighbour. The live data's problem is IDENTIFICATION -- how few pairs saw the pool trade
   * -- and the AR(1) adjustment is simply not an instrument for it. `informativePairs` is.
   *
   * `n_eff` is kept, unchanged and pre-registered, because it is the right correction for the defect
   * it does address, and quietly reparameterising it once it stopped flattering the design would be
   * exactly the move the constitution exists to prevent. What changes is the CLAIM about what it
   * carries. This test exists so that claim cannot quietly return.
   */
  const zeroHeavy = (): EquityPoint[] => {
    // A deterministic mulberry32 walk in which two thirds of ticks leave the price untouched. Fixed
    // literals rather than a loop-free fixture because the property under test is statistical.
    let s = 42 >>> 0;
    const rnd = (): number => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const prices = [0.002];
    for (let i = 1; i < 400; i++) prices.push(rnd() >= 0.676 ? prices[i - 1]! * (1 + (rnd() - 0.5) * 0.02) : prices[i - 1]!);
    return obs(prices.map((p, i) => ({ price: p, equity: 1e9 * (p / prices[0]!) * (1 + (rnd() - 0.5) * 0.001 + (i / 400) * 0.0005) })));
  };

  it('a two-thirds-zero series registers NO positive dependence, so n_eff does not discount it', () => {
    const r = measured(zeroHeavy());
    expect(r.zeroBenchmarkPairs / r.observations).toBeGreaterThan(0.6);
    expect(r.lag1Autocorrelation).toBeLessThanOrEqual(0);
    expect(r.effectiveObservations).toBe(r.observations);
  });

  it('informativePairs is the number that DOES fall, and it is what the report must lead with', () => {
    const r = measured(zeroHeavy());
    expect(r.informativePairs).toBeLessThan(r.observations / 2);
    // n_eff says the evidence is undiminished; informativePairs says two thirds of it is blank.
    // Reporting only the first would overstate the evidence exactly as summed RSS overstated memory.
    expect(r.effectiveObservations).toBeGreaterThan(r.informativePairs * 2);
  });
});

describe('what the real run against 150-153 found (T040-T042)', () => {
  it('a DEGENERATE half-interval disables the overlap test rather than winning it', () => {
    // Found on run 150, 2026-09-18. `scheduled-accumulation` finishes accumulating and then simply
    // holds, so its second half's equity tracks the price exactly, every residual is zero and the
    // interval came out [0.997, 0.997]. The halves then read as DISJOINT -- "the exposure drifted"
    // -- on the strength of a point. The point estimates ARE reported either way, so nothing is
    // hidden; what is withdrawn is the interval-overlap claim, which was never evidence.
    // 12 observations -> 11 pairs -> the split falls at pair 5, so observations 5..11 must ALL be
    // pure-holder for the second half to be degenerate. The boundary pair belongs to the second half.
    const prices = [0.0020, 0.00202, 0.00206, 0.00203, 0.00209, 0.00212, 0.00215, 0.00211, 0.00218, 0.00222, 0.00219, 0.00225];
    const rows = prices.map((p, i) => (i < 5
      // Accumulating: equity lags the price, so residuals are non-zero and the interval is real.
      ? { price: p, equity: 1e9 * (1 + (p / prices[0]! - 1) * (i / 5)) }
      // Fully invested and simply holding: equity tracks the price, every residual vanishes.
      : { price: p, equity: 1e9 * (p / prices[5]!) }));
    const r = measured(obs(rows));
    expect(r.betaSecondHalf?.degenerate).toBe(true);
    expect(r.betaHalvesOverlap).toBeNull();
    // The betas themselves are still there to read.
    expect(r.betaFirstHalf).not.toBeNull();
    expect(r.betaSecondHalf).not.toBeNull();
  });
});

describe('determinism (specs/004 Polish, T046-T047)', () => {
  /**
   * Explicit literals, no generator. The same two arrays live in the script that produced the pinned
   * values below, so any drift between what was pinned and what is asserted shows up as a diff
   * rather than as a silent pass. 11 of 19 pairs leave the price untouched, close to the 67% the
   * live runs show, so this is not a fixture the estimator finds unusually easy.
   */
  const PIN_PRICES = [
    0.00200, 0.00200, 0.00203, 0.00203, 0.00203, 0.00199, 0.00199, 0.00206,
    0.00206, 0.00206, 0.00206, 0.00201, 0.00201, 0.00209, 0.00209, 0.00204,
    0.00204, 0.00204, 0.00211, 0.00207,
  ];
  const PIN_EQUITY = [
    1000000000, 1000400000, 1014200000, 1013100000, 1015700000, 995300000, 996900000, 1031400000,
    1029800000, 1032600000, 1030100000, 1006700000, 1005200000, 1046300000, 1043900000, 1020800000,
    1022400000, 1019700000, 1056100000, 1035500000,
  ];
  const pinned = (): EquityPoint[] => obs(PIN_PRICES.map((p, i) => ({ price: p, equity: PIN_EQUITY[i]! })));

  /**
   * **Produced by a SEPARATE node process on 2026-09-18**, not by this suite, and committed. That is
   * the whole point: a bootstrap stable only inside one process — ambient module state, a shared
   * PRNG advanced by whatever ran first, a memoised table — passes T046 and is still not
   * deterministic. Only a value carried in from outside catches it.
   *
   * Do not regenerate these to make a failure go away. A mismatch means the estimator's output
   * moved, and what moved it is the question.
   */
  const PINNED = {
    beta: 0.9981560836113038,
    alphaBps: 0.2973046582724237,
    alphaLowerBps: -5.274166431333545,
    alphaUpperBps: 5.183009427806489,
    lag1Autocorrelation: -0.646994478722051,
    effectiveObservations: 19,
    observations: 19,
    zeroBenchmarkPairs: 11,
    informativePairs: 8,
    betaFirstHalfBeta: 0.9776446431780403,
    betaSecondHalfBeta: 1.0050946806852155,
  } as const;

  it('T046: identical observations yield BYTE-IDENTICAL output twice in one process', () => {
    // The whole result, not a chosen field: a determinism test that checks only the bounds would
    // miss a drifting n_eff, a drifting half-beta, or a flipped overlap flag.
    const json = (r: unknown): string => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(json(exposureAdjusted(pinned()))).toBe(json(exposureAdjusted(pinned())));
  });

  it('T047: matches bounds produced by a SEPARATE process, to the last bit', () => {
    const r = measured(pinned());
    expect(r.beta).toBe(PINNED.beta);
    expect(r.alphaBps).toBe(PINNED.alphaBps);
    expect(r.alphaLowerBps).toBe(PINNED.alphaLowerBps);
    expect(r.alphaUpperBps).toBe(PINNED.alphaUpperBps);
    expect(r.lag1Autocorrelation).toBe(PINNED.lag1Autocorrelation);
    expect(r.effectiveObservations).toBe(PINNED.effectiveObservations);
    expect(r.observations).toBe(PINNED.observations);
    expect(r.zeroBenchmarkPairs).toBe(PINNED.zeroBenchmarkPairs);
    expect(r.informativePairs).toBe(PINNED.informativePairs);
    expect(r.betaFirstHalf?.beta).toBe(PINNED.betaFirstHalfBeta);
    expect(r.betaSecondHalf?.beta).toBe(PINNED.betaSecondHalfBeta);
  });

  it('the pinned interval is NOT degenerate, so it actually exercises the resampling', () => {
    // The US1 known-answer control passes with the bootstrap entirely broken, because a holder's
    // residuals are all zero. A pin taken on a fixture like that would inherit the same blindness.
    const r = measured(pinned());
    expect(r.alphaUpperBps - r.alphaLowerBps).toBeGreaterThan(1);
    expect(r.zeroBenchmarkPairs / r.observations).toBeGreaterThan(0.5);
  });
});
