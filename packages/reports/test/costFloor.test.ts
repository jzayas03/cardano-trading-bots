/**
 * The pure cost-floor surface. These tests import the REAL `cpmmAmountOut`, `tryCostsForPoolId` and
 * `venueOf` and inject them, so nothing here is a stand-in that could be looser than production.
 * Test files are not scanned by the purity guard, which is what makes that possible.
 */
import { cpmmAmountOut, tryCostsForPoolId, venueOf } from '@ctb/sim-executor';
import { describe, expect, it } from 'vitest';
import {
  costDistributions,
  costObservations,
  lookupFloor,
  MIN_OBSERVATIONS,
  SIZE_BUCKETS_LOVELACE,
  type CostObservation,
  type CostObservationDeps,
  type SnapshotInput,
} from '../src/costFloor.js';

const DEPS: CostObservationDeps = { cpmm: cpmmAmountOut, costsFor: tryCostsForPoolId, venueOf };
const ADA = 1_000_000n;

function snap(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    poolId: 'MinswapV2:deadbeef',
    baseUnit: 'token',
    tickTs: new Date('2026-09-10T00:00:00Z'),
    // A deliberately deep pool: 1,000,000 ADA a side, so curve impact is negligible and the
    // remaining cost is exactly the two pool fees plus the fixed venue fees. That isolation is
    // what lets the fee-double-counting test below be unambiguous.
    reserveQuote: 1_000_000n * ADA,
    reserveBase: 1_000_000n * ADA,
    feeBps: 30,
    tvlLovelace: 2_000_000n * ADA,
    ...over,
  };
}

describe('costObservations', () => {
  it('produces one observation per (snapshot, size bucket)', () => {
    const { observations } = costObservations([snap(), snap()], DEPS);
    expect(observations).toHaveLength(2 * SIZE_BUCKETS_LOVELACE.length);
  });

  it('yields NO observation for non-positive reserves, rather than an Infinity one', () => {
    for (const bad of [{ reserveBase: 0n }, { reserveQuote: 0n }, { reserveBase: -1n }]) {
      const { observations } = costObservations([snap(bad)], DEPS);
      expect(observations).toEqual([]);
    }
  });

  it('yields no observation for an out-of-range pool fee', () => {
    const { observations } = costObservations([snap({ feeBps: 10_000 }), snap({ feeBps: -1 })], DEPS);
    expect(observations).toEqual([]);
  });

  it('roundTripBps is impact + fixed fee and nothing else', () => {
    const { observations } = costObservations([snap()], DEPS);
    for (const o of observations) {
      expect(o.roundTripBps).toBeCloseTo(o.impactBps + o.fixedFeeBps, 6);
    }
  });

  it('counts the fixed venue fee TWICE, once per leg, over the lovelace notional', () => {
    const costs = tryCostsForPoolId('MinswapV2:deadbeef')!;
    const notional = 1_000n * ADA;
    const { observations } = costObservations([snap()], DEPS, { sizes: [notional] });
    const expected = Number((costs.batcherFeeLovelace + costs.networkFeeLovelace) * 2n) / Number(notional) * 10_000;
    expect(observations[0]!.fixedFeeBps).toBeCloseTo(expected, 2);
  });

  it('CONTROL: the pool fee is ALREADY inside impactBps, so charging it again nearly doubles it', () => {
    // Isolate the fee from own impact by going very deep: at 100,000,000 ADA a side a 1,000 ADA
    // trade moves the price by ~0.0001 bps, so whatever cost remains IS the pool fee.
    const deep = { reserveQuote: 100_000_000n * ADA, reserveBase: 100_000_000n * ADA };
    const sizes = [1_000n * ADA];
    const withFee = costObservations([snap({ ...deep, feeBps: 30 })], DEPS, { sizes }).observations[0]!;
    const noFee = costObservations([snap({ ...deep, feeBps: 0 })], DEPS, { sizes }).observations[0]!;

    // At this depth own impact is 0.1 bps one way, 0.2 round trip -- real, and tiny.
    expect(noFee.impactBps).toBeLessThan(0.5);
    // The DIFFERENCE the fee makes is 30 bps on each of the two legs. Asserting the difference
    // rather than the absolute keeps this control independent of the pool depth chosen.
    expect(withFee.impactBps - noFee.impactBps).toBeCloseTo(60, 1);

    // This is the defect FR-006 exists for, shown as arithmetic. A decomposition that charges the
    // pool fee ALONGSIDE an impact term ("pool fee + impact + spread") nearly doubles the real cost,
    // because the fee is already inside the impact term.
    const doubleCounted = withFee.impactBps + 2 * 30;
    expect(doubleCounted).toBeGreaterThan(withFee.impactBps * 1.9);
    expect(withFee.roundTripBps).toBeLessThan(doubleCounted);
  });

  it('impact grows with order size (C1.5), while the fixed fee in bps shrinks', () => {
    // A SHALLOWER pool on purpose: 100k ADA a side, so own price impact is material across the
    // bucket range. On the 1,000,000 ADA pool used elsewhere a 100 ADA trade has so little impact
    // that `cpmmAmountOut`'s integer flooring dominates it, and the sequence inverts by ~0.01 bps
    // -- truncation noise, not a real inversion. Asserting a curve property needs a regime where
    // the curve, not the rounding, is what moves.
    const { observations } = costObservations([snap({ reserveQuote: 100_000n * ADA, reserveBase: 100_000n * ADA })], DEPS);
    const bySize = [...observations].sort((a, b) => Number(a.sizeBucketLovelace - b.sizeBucketLovelace));
    for (let i = 1; i < bySize.length; i++) {
      expect(bySize[i]!.impactBps).toBeGreaterThanOrEqual(bySize[i - 1]!.impactBps);
      expect(bySize[i]!.fixedFeeBps).toBeLessThan(bySize[i - 1]!.fixedFeeBps);
    }
  });

  it('refuses an unknown venue with an exclusion, never a default cost (C1.4)', () => {
    const { observations, exclusions } = costObservations([snap({ poolId: 'NotAVenue:abc' })], DEPS);
    expect(observations).toEqual([]);
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0]).toMatchObject({ venue: 'NotAVenue', reason: 'unmeasured-fee', snapshotsAvailable: 1 });
  });

  it('records a policy-excluded venue with its reason and the snapshots given up (FR-017)', () => {
    const excludedVenues = new Map([['Splash', { reason: 'varies-by-pool' as const, detail: 'take varies BY POOL' }]]);
    const { observations, exclusions } = costObservations([snap({ poolId: 'Splash:aa' })], DEPS, { excludedVenues });
    expect(observations).toEqual([]);
    expect(exclusions[0]).toMatchObject({ venue: 'Splash', reason: 'varies-by-pool', snapshotsAvailable: 1 });
  });
});

describe('costDistributions', () => {
  function obs(n: number, bps: number): CostObservation[] {
    return Array.from({ length: n }, (_, i) => ({
      poolId: 'MinswapV2:deadbeef',
      venue: 'MinswapV2',
      sizeBucketLovelace: 1_000n * ADA,
      tickTs: new Date(Date.UTC(2026, 8, 10, 0, i)),
      roundTripBps: bps + i,
      impactBps: bps,
      fixedFeeBps: 0,
      tvlLovelace: 100n * ADA,
      source: 'quote' as const,
    }));
  }

  it('STRUCTURAL: an insufficient bucket has p50, p75, p90 and floorBps all null IN THE DATA', () => {
    const [d] = costDistributions(obs(MIN_OBSERVATIONS - 1, 100));
    expect(d!.verdict).toBe('insufficient');
    expect(d!.p50).toBeNull();
    expect(d!.p75).toBeNull();
    expect(d!.p90).toBeNull();
    expect(d!.floorBps).toBeNull();
  });

  it('carries n, firstTs and lastTs on EVERY distribution, including insufficient ones (C2.3)', () => {
    for (const n of [1, MIN_OBSERVATIONS - 1, MIN_OBSERVATIONS, MIN_OBSERVATIONS + 5]) {
      const [d] = costDistributions(obs(n, 100));
      expect(d!.n).toBe(n);
      expect(d!.firstTs).toBeInstanceOf(Date);
      expect(d!.lastTs).toBeInstanceOf(Date);
      expect(d!.lastTs.getTime()).toBeGreaterThanOrEqual(d!.firstTs.getTime());
    }
  });

  it('floorBps === p90 exactly when sufficient (C2.4, D2)', () => {
    const [d] = costDistributions(obs(MIN_OBSERVATIONS, 100));
    expect(d!.verdict).toBe('sufficient');
    expect(d!.p90).not.toBeNull();
    expect(d!.floorBps).toBe(d!.p90);
    expect(d!.p50!).toBeLessThanOrEqual(d!.p75!);
    expect(d!.p75!).toBeLessThanOrEqual(d!.p90!);
  });

  it('groups by (pool, size) and never produces a venue-level aggregate (C2.1)', () => {
    const a = obs(MIN_OBSERVATIONS, 100);
    const b = obs(MIN_OBSERVATIONS, 400).map((o) => ({ ...o, poolId: 'MinswapV2:other' }));
    const out = costDistributions([...a, ...b]);
    expect(out).toHaveLength(2);
    expect(out.every((d) => d.poolId !== '')).toBe(true);
    // No row that stands for a whole venue: every row names a specific pool.
    expect(out.map((d) => d.poolId).sort()).toEqual(['MinswapV2:deadbeef', 'MinswapV2:other']);
  });

  it('takes the WEAKEST basis among components (C2.5)', () => {
    const [d] = costDistributions(obs(MIN_OBSERVATIONS, 100), { basisFor: () => 'assumed' });
    expect(d!.basis).toBe('assumed');
    const [m] = costDistributions(obs(MIN_OBSERVATIONS, 100), { basisFor: () => 'measured' });
    expect(m!.basis).toBe('measured');
  });

  it('is deterministic and sorted by (venue, pool, size)', () => {
    const input = [...obs(MIN_OBSERVATIONS, 100), ...obs(MIN_OBSERVATIONS, 100).map((o) => ({ ...o, poolId: 'MinswapV2:aaa' }))];
    const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    expect(j(costDistributions(input))).toBe(j(costDistributions([...input].reverse())));
    expect(costDistributions(input)[0]!.poolId).toBe('MinswapV2:aaa');
  });
});

describe('lookupFloor', () => {
  const sizes = [100n * ADA, 1_000n * ADA];
  function dists(n: number) {
    const o = Array.from({ length: n }, (_, i) => ({
      poolId: 'MinswapV2:deadbeef',
      venue: 'MinswapV2',
      sizeBucketLovelace: 1_000n * ADA,
      tickTs: new Date(Date.UTC(2026, 8, 10, 0, i)),
      roundTripBps: 200 + i,
      impactBps: 200,
      fixedFeeBps: 0,
      tvlLovelace: 100n * ADA,
      source: 'quote' as const,
    }));
    return costDistributions(o);
  }

  it('returns a floor with basis and n when sufficient', () => {
    const r = lookupFloor(dists(MIN_OBSERVATIONS), [], 'MinswapV2:deadbeef', 1_000n * ADA, sizes);
    expect(r.kind).toBe('floor');
    if (r.kind === 'floor') {
      expect(r.n).toBe(MIN_OBSERVATIONS);
      expect(r.bps).toBeGreaterThan(0);
    }
  });

  it('returns insufficient, never a number, when the bucket is thin (C3.1)', () => {
    const r = lookupFloor(dists(MIN_OBSERVATIONS - 1), [], 'MinswapV2:deadbeef', 1_000n * ADA, sizes);
    expect(r.kind).toBe('insufficient');
    expect(r).not.toHaveProperty('bps');
  });

  it('rounds UP to the next bucket, the conservative answer (C3.2)', () => {
    const r = lookupFloor(dists(MIN_OBSERVATIONS), [], 'MinswapV2:deadbeef', 500n * ADA, sizes);
    expect(r.kind).toBe('floor');
  });

  it('refuses above the largest bucket rather than extrapolating (C3.3)', () => {
    const r = lookupFloor(dists(MIN_OBSERVATIONS), [], 'MinswapV2:deadbeef', 10_000n * ADA, sizes);
    expect(r.kind).toBe('insufficient');
  });

  it('an unknown pool is EXCLUDED, not insufficient -- different facts (C3.4)', () => {
    const r = lookupFloor(dists(MIN_OBSERVATIONS), [], 'Splash:zzz', 1_000n * ADA, sizes);
    expect(r.kind).toBe('excluded');
    if (r.kind === 'excluded') expect(r.venue).toBe('Splash');
  });

  it('carries the recorded exclusion reason when one exists', () => {
    const ex = [{ venue: 'Splash', reason: 'varies-by-pool' as const, detail: 'x', snapshotsAvailable: 5 }];
    const r = lookupFloor(dists(MIN_OBSERVATIONS), ex, 'Splash:zzz', 1_000n * ADA, sizes);
    if (r.kind === 'excluded') expect(r.reason).toBe('varies-by-pool');
    else throw new Error('expected excluded');
  });
});
