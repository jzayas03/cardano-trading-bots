import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '@ctb/engine';
import { ASSUMED_STAKING_APR_PCT, stakingCredit, withStakingCredit } from '../src/index.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const at = (ms: number, cash: bigint, equity = cash): EquityPoint => ({
  tickTs: new Date(ms), cashLovelace: cash, positionBase: 0n,
  equityLovelace: equity, equityExecutableLovelace: null, price: '1',
});

describe('staking credit on idle ADA', () => {
  it('accrues the full rate on cash held for a year', () => {
    // 1000 ADA at 3% for a year is 30 ADA. Left-endpoint accrual: the balance at the START of each
    // interval is the balance that was staked through it.
    const credit = stakingCredit([at(0, 1_000_000_000n), at(YEAR_MS, 1_000_000_000n)], 3);
    expect(credit).toBe(30_000_000n);
  });

  it('accrues proportionally to elapsed time, however unevenly the points are spaced', () => {
    const half = stakingCredit([at(0, 1_000_000_000n), at(YEAR_MS / 2, 1_000_000_000n)], 3);
    expect(half).toBe(15_000_000n);
    const split = stakingCredit(
      [at(0, 1_000_000_000n), at(YEAR_MS / 4, 1_000_000_000n), at(YEAR_MS / 2, 1_000_000_000n)], 3);
    expect(split).toBe(half); // the same year, sampled twice as often
  });

  it('credits ONLY ADA — a position in the token earns nothing', () => {
    // This is the whole shape of the correction: staking is an ADA yield, so it rewards the run
    // that is SITTING IN CASH, not the one that deployed. A fully deployed run earns zero.
    const deployed: EquityPoint[] = [
      { ...at(0, 0n), positionBase: 1_000_000n, equityLovelace: 1_000_000_000n },
      { ...at(YEAR_MS, 0n), positionBase: 1_000_000n, equityLovelace: 1_000_000_000n },
    ];
    expect(stakingCredit(deployed, 3)).toBe(0n);
    expect(stakingCredit([at(0, 1_000_000_000n), at(YEAR_MS, 1_000_000_000n)], 3)).toBeGreaterThan(0n);
  });

  it('is a no-op at zero APR, which is the control that says the rest is not invented', () => {
    const eq = [at(0, 1_000_000_000n), at(YEAR_MS, 1_000_000_000n)];
    expect(stakingCredit(eq, 0)).toBe(0n);
    expect(withStakingCredit(eq, 0).map((p) => p.equityLovelace)).toEqual(eq.map((p) => p.equityLovelace));
  });

  it('adds the running credit to equity without touching cash or the position', () => {
    const [first, last] = withStakingCredit([at(0, 1_000_000_000n), at(YEAR_MS, 1_000_000_000n)], 3);
    expect(first!.equityLovelace).toBe(1_000_000_000n); // nothing accrued yet at the first point
    expect(last!.equityLovelace).toBe(1_030_000_000n);
    // Cash is untouched: this is an "as if" credit for MEASUREMENT, not rewards paid into the run.
    // Crediting cash would change what the strategy could afford and make it a different run.
    expect(last!.cashLovelace).toBe(1_000_000_000n);
    expect(last!.positionBase).toBe(0n);
  });

  it('refuses an unreadable timestamp rather than accruing over a NaN interval', () => {
    const bad = { ...at(0, 1_000_000_000n), tickTs: new Date('nope') };
    expect(() => stakingCredit([bad, at(YEAR_MS, 1_000_000_000n)], 3)).toThrow(/tickTs/);
  });

  it('refuses a negative rate and handles trivial series', () => {
    expect(() => stakingCredit([at(0, 1n), at(1, 1n)], -1)).toThrow(/negative/i);
    expect(stakingCredit([], 3)).toBe(0n);
    expect(stakingCredit([at(0, 1_000_000_000n)], 3)).toBe(0n); // one point spans no time
  });

  it('carries its rate as an ASSUMPTION, not a measurement', () => {
    // Cardano staking depends on protocol parameters and pool performance. The default is a
    // placeholder so the correction can be applied at all; the founder's own measured figure
    // replaces it, and every report says which was used.
    expect(ASSUMED_STAKING_APR_PCT).toBeGreaterThan(0);
    expect(ASSUMED_STAKING_APR_PCT).toBeLessThan(10);
  });
});
