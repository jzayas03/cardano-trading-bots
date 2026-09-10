import { describe, expect, it } from 'vitest';
import { decimalToScaled, priceAdaPerToken } from '@ctb/candles';
import type { Candle, FillResult } from '@ctb/engine';
import { costsForPoolId, cpmmAmountOut, DEFAULT_COSTS, SimExecutor } from '../src/index.js';

const RQ = 52_331_970_594n;
const RB = 23_779_491n;
const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const MID = '0.002200718703104284'; // priceAdaPerToken(RQ, RB, 0)
const FIFTEEN_MIN = 15 * 60_000;
const at: Candle = { tickTs: new Date(Date.UTC(2026, 8, 6, 0, 0)), open: MID, high: MID, low: MID, close: MID, volumeQuote: null, poolId: 'SundaeSwapV3:x', poolType: 'cpmm', feeBps: 100,
  closeReserveBase: RB, closeReserveQuote: RQ, tvlLovelace: 2n * RQ };
// next's reserves are deliberately different from at's, so a fill computed from `at` instead of `next`
// (spec §7: fills use t+1, never t) produces different numbers and a mixed-up implementation is caught.
const next: Candle = { ...at, tickTs: new Date(Date.UTC(2026, 8, 6, 0, 5)), closeReserveQuote: RQ + 1_000_000_000n };
// The plan's hand-computed fixture: t+1 holds exactly what t held, so the t mid and the t+1 pool mid
// coincide and slippage must reproduce the hand numbers (292 bps buy, 496 bps sell).
const nextSameReserves: Candle = { ...at, tickTs: new Date(Date.UTC(2026, 8, 6, 0, 5)) };
const rich = { cashLovelace: 10_000_000_000n, positionBase: 10_000_000n };

/**
 * Independent recomputation of the two bps numbers from the formulas, with the reserves visible, so
 * the expectations below are derived rather than copied out of a previous run of the code under test
 * (finding C2). Deviation is (fill/reference - 1) for a buy and (1 - fill/reference) for a sell.
 */
function bps(fillPrice: string, reference: string, side: 'buy' | 'sell'): number {
  const fill = decimalToScaled(fillPrice);
  const ref = decimalToScaled(reference);
  const diff = side === 'buy' ? fill - ref : ref - fill;
  return Math.round(Number((diff * 10_000_000n) / ref) / 1000);
}
const fillPriceOf = (lovelace: bigint, base: bigint): string => priceAdaPerToken(lovelace, base, 0);

describe('SimExecutor cpmm_observed', () => {
  const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: FIFTEEN_MIN });

  it('fills the hand-computed buy at 292 bps slippage against the t mid (spec §4.5)', () => {
    const r = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, nextSameReserves, rich);
    expect(r).toMatchObject({ status: 'filled', poolId: 'SundaeSwapV3:x', unitIn: 'lovelace', amountIn: 1_000_000_000n, amountOut: 441_500n,
      unitOut: SNEK, poolFeeIn: 10_000_000n, batcherFeeLovelace: 1_280_000n, networkFeeLovelace: 200_000n, midPrice: MID,
      slippageBps: 292, priceImpactBps: 292, tsFill: nextSameReserves.tickTs });
    expect((r as { fillPrice: string }).fillPrice).toBe('0.002265005662514156');
  });

  it('fills the hand-computed sell at 496 bps slippage against the t mid', () => {
    const r = ex.fill({ side: 'sell', amountIn: 1_000_000n, reason: 't' }, at, nextSameReserves, rich);
    expect(r).toMatchObject({ status: 'filled', unitIn: SNEK, unitOut: 'lovelace', amountOut: 2_091_631_632n, slippageBps: 496, priceImpactBps: 496 });
  });

  it('separates slippage (vs the t mid) from price impact (vs the t+1 pool) when the pool moved', () => {
    // Recomputed here from the reserves, not copied: `next` holds RQ + 1 ADA, so the t+1 pool's own
    // mid is richer in ADA than the mid the strategy decided against at t.
    const out = cpmmAmountOut(1_000_000_000n, RQ + 1_000_000_000n, RB, 100);
    const fill = fillPriceOf(1_000_000_000n, out);
    const poolMid = priceAdaPerToken(RQ + 1_000_000_000n, RB, 0);
    const expectedSlippage = bps(fill, MID, 'buy');
    const expectedImpact = bps(fill, poolMid, 'buy');
    expect(expectedSlippage).not.toBe(expectedImpact); // the two numbers are genuinely different here
    const r = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, next, rich);
    expect(r).toMatchObject({ status: 'filled', amountOut: out, fillPrice: fill, midPrice: MID, slippageBps: expectedSlippage, priceImpactBps: expectedImpact });
  });

  it('separates the two numbers on the sell side too', () => {
    const out = cpmmAmountOut(1_000_000n, RB, RQ + 1_000_000_000n, 100);
    const fill = fillPriceOf(out, 1_000_000n);
    const poolMid = priceAdaPerToken(RQ + 1_000_000_000n, RB, 0);
    const r = ex.fill({ side: 'sell', amountIn: 1_000_000n, reason: 't' }, at, next, rich);
    expect(r).toMatchObject({ status: 'filled', amountOut: out, slippageBps: bps(fill, MID, 'sell'), priceImpactBps: bps(fill, poolMid, 'sell') });
  });

  it('reports a slippage that is reproducible from the stored midPrice and fillPrice to within 1 bp', () => {
    for (const side of ['buy', 'sell'] as const) {
      const amountIn = side === 'buy' ? 1_000_000_000n : 1_000_000n;
      const r = ex.fill({ side, amountIn, reason: 't' }, at, next, rich);
      expect(r.status).toBe('filled');
      const f = r as Extract<typeof r, { status: 'filled' }>;
      expect(Math.abs(f.slippageBps - bps(f.fillPrice, f.midPrice, side))).toBeLessThanOrEqual(1);
    }
  });

  it('rejects when t+1 has no reserves, or is not cpmm, or has no pool', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, { ...next, closeReserveBase: null }, rich)).toEqual({ status: 'rejected', reason: 'no reserves at t+1' });
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, { ...next, poolType: 'stable' as 'cpmm' }, rich)).toEqual({ status: 'rejected', reason: 'pool_type stable not cpmm' });
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, { ...next, poolId: null }, rich)).toEqual({ status: 'rejected', reason: 'no pool at t+1' });
  });

  // Finding M2: a null pool_type used to fall through the first check and be reported as
  // "no reserves at t+1", which named the wrong thing. One check, one accurate message.
  it('names a missing pool type accurately instead of blaming the reserves', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, { ...next, poolType: null }, rich)).toEqual({ status: 'rejected', reason: 'pool_type null not cpmm' });
  });

  it('rejects insufficient cash (fees included), insufficient position, and dust', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, next, { cashLovelace: 1_001_000_000n, positionBase: 0n })).toEqual({ status: 'rejected', reason: 'insufficient cash' });
    expect(ex.fill({ side: 'sell', amountIn: 5n, reason: 't' }, at, next, { cashLovelace: 0n, positionBase: 4n })).toEqual({ status: 'rejected', reason: 'insufficient position' });
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, next, rich)).toEqual({ status: 'rejected', reason: 'dust' });
  });

  // Finding M9: a sell can be rejected AFTER the swap is priced, when the ADA it returns still does
  // not cover the batcher + network fees. That branch had no test at all.
  it('rejects a sell whose proceeds still do not cover the lovelace fees', () => {
    // 500 SNEK out of this pool returns 1 089 333 lovelace (cpmmAmountOut(500n, RB, RQ, 100));
    // fees are 1 280 000 (SundaeSwapV3, what Dexter writes into the order) + 200 000 network
    // = 1 480 000, and there is no cash.
    const r = ex.fill({ side: 'sell', amountIn: 500n, reason: 't' }, at, nextSameReserves, { cashLovelace: 0n, positionBase: 500n });
    expect(r).toEqual({ status: 'rejected', reason: 'insufficient cash' });
    // With enough cash on hand to top the fees up (400 000 + 1 089 333 = 1 489 333 >= 1 480 000),
    // the very same sell clears. The 200 000 that used to be enough no longer is: raising the venue
    // fee moved this boundary, which is the boundary the test exists to pin.
    const ok = ex.fill({ side: 'sell', amountIn: 500n, reason: 't' }, at, nextSameReserves, { cashLovelace: 400_000n, positionBase: 500n });
    expect(ok.status).toBe('filled');
    // And one lovelace short of it still fails, so the boundary is pinned from both sides.
    expect(ex.fill({ side: 'sell', amountIn: 500n, reason: 't' }, at, nextSameReserves, { cashLovelace: 390_666n, positionBase: 500n }).status).toBe('rejected');
  });

  // Finding M1: an unrecognised venue prefix used to throw out of fill(), killing the whole run.
  // A pool we cannot cost is a rejected order, counted in the run like any other rejection.
  it('rejects an unknown venue instead of throwing', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, { ...next, poolId: 'FutureSwap:abc' }, rich))
      .toEqual({ status: 'rejected', reason: 'unknown venue FutureSwap' });
  });
});

/**
 * Plan 3 Task 6: `Fake` (`dev:fake-collector`'s synthetic venue) is deliberately not a Dexter venue —
 * `isDexName('Fake')` is false — so `tryCostsForPoolId` returns null for it and the executor's
 * unknown-venue rejection blocks it by default, exactly like `FutureSwap` above. `rehearsalVenue`
 * is the one escape hatch, and only for the venue it names.
 */
describe('SimExecutor rehearsalVenue', () => {
  const fakeNext: Candle = { ...next, poolId: 'Fake:SNEK' };

  it('rejects a Fake pool as an unknown venue when rehearsalVenue is not set', () => {
    const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: FIFTEEN_MIN });
    expect(ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, fakeNext, rich))
      .toEqual({ status: 'rejected', reason: 'unknown venue Fake' });
  });

  it('fills a Fake pool at DEFAULT_COSTS when rehearsalVenue is set to Fake', () => {
    const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: FIFTEEN_MIN, rehearsalVenue: 'Fake' });
    const r = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, fakeNext, rich);
    expect(r).toMatchObject({ status: 'filled', poolId: 'Fake:SNEK', batcherFeeLovelace: DEFAULT_COSTS.batcherFeeLovelace, networkFeeLovelace: DEFAULT_COSTS.networkFeeLovelace });
  });

  it('does not open the door for every other unknown venue — only the one named by rehearsalVenue', () => {
    const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: FIFTEEN_MIN, rehearsalVenue: 'Fake' });
    expect(ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, { ...next, poolId: 'FutureSwap:abc' }, rich))
      .toEqual({ status: 'rejected', reason: 'unknown venue FutureSwap' });
  });

  it('marks a Fake position to market when rehearsalVenue is set, and rejects it otherwise', () => {
    const atFake: Candle = { ...at, poolId: 'Fake:SNEK' };
    const withRehearsal = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: FIFTEEN_MIN, rehearsalVenue: 'Fake' });
    const withoutRehearsal = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: FIFTEEN_MIN });
    expect(withRehearsal.markToMarket({ cashLovelace: 0n, positionBase: 1_000_000n }, atFake)).not.toBeNull();
    expect(withoutRehearsal.markToMarket({ cashLovelace: 0n, positionBase: 1_000_000n }, atFake)).toBeNull();
  });
});

/**
 * Finding C3: GeckoTerminal history is sparse — 561 of 4968 consecutive SNEK pairs are more than an
 * hour apart, the widest 7h25m. Filling an intent decided at t against a "t+1" seven hours later is
 * not a batcher delay, it is a different market. The bound is a required option; the boundary itself
 * is inclusive, so only a gap strictly wider than the bound is stale.
 */
describe('SimExecutor stale t+1 rejection', () => {
  const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: FIFTEEN_MIN });
  const gapped = (ms: number): Candle => ({ ...next, tickTs: new Date(at.tickTs.getTime() + ms) });

  it('fills at exactly the bound', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, gapped(FIFTEEN_MIN), rich).status).toBe('filled');
  });

  it('rejects one millisecond past the bound and names the gap', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, gapped(FIFTEEN_MIN + 1), rich))
      .toEqual({ status: 'rejected', reason: 'stale t+1 (gap 15m)' });
  });

  it('rounds the reported gap to whole minutes', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, gapped(7 * 3_600_000 + 25 * 60_000), rich))
      .toEqual({ status: 'rejected', reason: 'stale t+1 (gap 445m)' });
  });
});

describe('SimExecutor cpmm_synthetic_depth', () => {
  it('builds reserves from price and declared depth and fills with the same math', () => {
    const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: RQ }, maxGapMs: FIFTEEN_MIN });
    const ext: Candle = { ...next, poolId: null, poolType: null, feeBps: null, closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null, volumeQuote: '10' };
    const r = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, { ...at, poolId: null }, ext, rich);
    // synthetic reserveBase = RQ / price = 23 779 491 (rounding may differ by 1); fee default 30 bps
    expect(r.status).toBe('filled');
    const f = r as Extract<typeof r, { status: 'filled' }>;
    expect(f.poolId).toBe('synthetic');
    expect(f.poolFeeIn).toBe(3_000_000n);
    expect(f.amountOut).toBeGreaterThan(441_500n); // lower fee than the observed pool
    expect(f.amountOut).toBeLessThan(RB);
    // The synthetic pool is built AT the t+1 close, so impact is measured against that, while
    // slippage is still measured against the mid the strategy saw at t.
    expect(f.priceImpactBps).toBeGreaterThan(0);
    expect(f.midPrice).toBe(MID);
  });
});

describe('costsForPoolId', () => {
  it('returns the venue table and applies overrides', () => {
    expect(costsForPoolId('MinswapV2:abc')).toMatchObject({ batcherFeeLovelace: 2_000_000n, basis: 'assumed' });
    expect(costsForPoolId('Splash:abc', { batcherFeeLovelace: 1_500_000n }))
      .toMatchObject({ batcherFeeLovelace: 1_500_000n, networkFeeLovelace: 200_000n, basis: 'assumed', source: 'cli override' });
    expect(() => costsForPoolId('FutureSwap:abc')).toThrow(/unknown venue/);
  });
});

describe('markToMarket', () => {
  const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: 900_000 });
  const atEq: Candle = { ...at, closeReserveQuote: RQ }; // equal-reserves fixture
  it('values the position as a full sell net of fees on observed reserves (SundaeSwapV3: 1.28 ADA batcher + 0.2 ADA network)', () => {
    expect(ex.markToMarket({ cashLovelace: 0n, positionBase: 1_000_000n }, atEq)).toBe(2_091_631_632n - 1_280_000n - 200_000n);
  });
  it('is cash when flat and null without reserves', () => {
    expect(ex.markToMarket({ cashLovelace: 5n, positionBase: 0n }, atEq)).toBe(5n);
    expect(ex.markToMarket({ cashLovelace: 5n, positionBase: 1n }, { ...atEq, closeReserveBase: null })).toBeNull();
  });
});
describe('reserve depletion', () => {
  const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: 900_000 });
  const nextEq: Candle = { ...next, closeReserveQuote: RQ };
  it('a second buy in the same candle fills against poolAfter of the first', () => {
    const first = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 'a' }, at, nextEq, rich);
    expect(first).toMatchObject({ status: 'filled', amountOut: 441500n, poolAfter: { poolId: 'SundaeSwapV3:x', reserveQuote: 53331970594n, reserveBase: 23337991n, feeBps: 100 } });
    const working = (first as Extract<FillResult, { status: 'filled' }>).poolAfter!;
    const second = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 'b' }, at, nextEq, rich, working);
    expect(second).toMatchObject({ status: 'filled', amountOut: 425327n });
  });
});
describe('synthetic worst-of pricing', () => {
  const depth = RQ;
  const ext = (open: string, close: string): Candle => ({ ...next, open, high: close, low: open, close, poolId: null, poolType: null, feeBps: null, closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null, volumeQuote: '1' });
  const buy = (price: 'close' | 'worst') => new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: depth, price }, maxGapMs: 900_000 })
    .fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, ext('0.002300000000000000', '0.002100000000000000'), rich) as Extract<FillResult, { status: 'filled' }>;
  const sell = (price: 'close' | 'worst') => new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: depth, price }, maxGapMs: 900_000 })
    .fill({ side: 'sell', amountIn: 1_000_000n, reason: 't' }, at, ext('0.002100000000000000', '0.002300000000000000'), rich) as Extract<FillResult, { status: 'filled' }>;
  it('buys at max(open, close) and sells at min(open, close) under worst; close otherwise', () => {
    // buy fixture: open 0.0023, close 0.0021 -> worst prices at the open (0.0023), fewer tokens than the close-priced fill
    expect(buy('worst').amountOut).toBeLessThan(buy('close').amountOut);
    // sell fixture: open 0.0021, close 0.0023 -> worst prices at the open (0.0021), less lovelace than the close-priced fill
    expect(sell('worst').amountOut).toBeLessThan(sell('close').amountOut);
  });
});

describe('synthetic mark agrees with the synthetic fill', () => {
  // The mark path (`markToMarket`) and the fill path (`fill`) both build the synthetic pool from a
  // price and a declared depth. If the two ever derived reserves differently, an equity curve would
  // disagree with the sell it claims to stand for. So: mark a position at candle C, then sell the
  // whole position against a t+1 candle priced exactly like C; the mark must equal the proceeds net
  // of fees. Under `close` mode the fill prices at next.close, so open/close are set equal here.
  const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: RQ }, maxGapMs: FIFTEEN_MIN });
  const bare = { poolId: null, poolType: null, feeBps: null, closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null, volumeQuote: '1' } as const;
  const c: Candle = { ...at, ...bare };
  const c1: Candle = { ...next, ...bare, open: MID, close: MID };
  const position = { cashLovelace: 0n, positionBase: 1_000_000n };
  it('marks the position at exactly what a full sell against the same price yields', () => {
    const mark = ex.markToMarket(position, c);
    const r = ex.fill({ side: 'sell', amountIn: position.positionBase, reason: 't' }, c, c1, { ...position, cashLovelace: 10_000_000n }) as Extract<FillResult, { status: 'filled' }>;
    expect(r.status).toBe('filled');
    expect(mark).toBe(r.amountOut - r.batcherFeeLovelace - r.networkFeeLovelace);
    expect(mark).toBeGreaterThan(0n);
  });
  it('is null for the mark and a rejection for the fill under the same unusable inputs', () => {
    const zero = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: 0n }, maxGapMs: FIFTEEN_MIN });
    expect(zero.markToMarket(position, c)).toBeNull();
    expect(zero.fill({ side: 'sell', amountIn: 1n, reason: 't' }, c, c1, rich)).toEqual({ status: 'rejected', reason: 'synthetic depth must be positive' });
    expect(ex.markToMarket(position, { ...c, close: '0' })).toBeNull();
    expect(ex.fill({ side: 'sell', amountIn: 1n, reason: 't' }, c, { ...c1, close: '0', open: '0' }, rich)).toEqual({ status: 'rejected', reason: 'no price at t+1' });
  });
});

/**
 * Finding M3: `deviationBps` divides by its reference price with no guard. `midScaled` (the t close)
 * is checked — `no mid price at t` — but `poolMidScaled`, the t+1 pool's own mid used for
 * `priceImpactBps`, is not. It is derived from reserves, and a pool whose quote reserve is minute
 * against a large base reserve prices below 1e-18 ADA per token, which `decimalToScaled` floors to
 * 0. The fill then died with a bigint `RangeError: Division by zero` thrown out of `Executor.fill` —
 * inside the engine's settle step, which has no catch, so one degenerate pool killed the whole paper
 * run rather than costing it one order. An unmeasurable impact reports as 0.
 */
describe('SimExecutor price-impact guard (finding M3)', () => {
  const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: FIFTEEN_MIN });
  // 1 lovelace against 1e18 base units: (1 * 1e18) / (1e18 * 1e6) floors to a scaled mid of 0.
  const degenerate: Candle = { ...at, tickTs: new Date(Date.UTC(2026, 8, 6, 0, 5)), poolId: 'Minswap:x', closeReserveQuote: 1n, closeReserveBase: 10n ** 18n };

  it('does not throw when the t+1 pool mid floors to zero', () => {
    expect(decimalToScaled(priceAdaPerToken(1n, 10n ** 18n, 0)), 'the fixture really does floor to zero').toBe(0n);
    expect(() => ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, degenerate, rich)).not.toThrow();
  });

  it('reports priceImpactBps 0 rather than a number divided by nothing, and still fills', () => {
    const r = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, degenerate, rich);
    expect(r.status).toBe('filled');
    expect((r as { priceImpactBps: number }).priceImpactBps).toBe(0);
    // Slippage is measured against the t mid, which is healthy here, so it is NOT zeroed out too.
    expect((r as { slippageBps: number }).slippageBps).not.toBe(0);
  });
});
