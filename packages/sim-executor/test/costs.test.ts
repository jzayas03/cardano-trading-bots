import { describe, expect, it } from 'vitest';
import type { FillResult } from '@ctb/engine';
import { assumedVenuesTouched, costsForPoolId } from '../src/index.js';

describe('VENUE_COSTS (read from venue docs 2026-09-06, see M2 report §1)', () => {
  it('carries the documented values', () => {
    // Minswap V1 was 0n on the documentation until 2026-09-16, when 13 of 13 live fulfilments came
    // back at exactly 2.000000 ADA with zero variance. Same correction V2 got, same reason.
    expect(costsForPoolId('Minswap:x').batcherFeeLovelace).toBe(2_000_000n);
    expect(costsForPoolId('SundaeSwapV1:x').batcherFeeLovelace).toBe(2_500_000n);
    // 1.28, not the documented 0.5-1.0 range: measured on chain 2026-09-16, see the test below.
    expect(costsForPoolId('SundaeSwapV3:x').batcherFeeLovelace).toBe(1_280_000n);
    expect(costsForPoolId('MuesliSwap:x').batcherFeeLovelace).toBe(2_000_000n); // was 950_000n until 2026-09-16
    expect(costsForPoolId('Minswap:x').basis).toBe('measured');
    expect(costsForPoolId('SundaeSwapV1:x').basis).toBe('documented'); // unverified, NOT refuted
    expect(costsForPoolId('MuesliSwap:x').basis).toBe('assumed'); // flat figure refuted in shape
  });
  it('marks the unverified venues as assumed at 2 ADA', () => {
    // MuesliSwap joined this list on 2026-09-16 and its value went UP, from a documented 0.95. Seven
    // live fulfilments spanned 0.0049 to 3.4657 ADA per order, so the flat figure is refuted in
    // SHAPE rather than merely unverified, and `assumed` is exactly the grade for "no usable number".
    for (const v of ['WingRiders', 'WingRidersV2', 'VyFinance', 'Splash', 'MuesliSwap']) {
      const c = costsForPoolId(`${v}:x`);
      expect(c.batcherFeeLovelace).toBe(2_000_000n);
      expect(c.basis).toBe('assumed');
    }
  });
  // MinswapV2 was in the list above until 2026-09-16, when four live mainnet orders were read and
  // every one carried 2 ADA in the datum field the validator enforces. Same number, different grade:
  // it is no longer an inference from what Dexter writes, it is what the chain takes.
  it('MinswapV2 is measured, at the same 2 ADA, and cites its evidence', () => {
    const c = costsForPoolId('MinswapV2:x');
    expect(c.batcherFeeLovelace).toBe(2_000_000n);
    expect(c.basis).toBe('measured');
    expect(c.source).toMatch(/MEASURED ON CHAIN 2026-09-16/);
    expect(c.readAt).toBe('2026-09-16');
  });

  // The behavioural point of the grade: a measured venue stops being named in the report's
  // assumed-costs warning, because the warning means "this number might not be what you pay" and
  // for this one venue we went and looked.
  it('assumedVenuesTouched does NOT flag a measured venue', () => {
    const filled = (poolId: string): { result: FillResult } => ({ result: { status: 'filled', poolId, unitIn: 'lovelace', amountIn: 1n, unitOut: 'x', amountOut: 1n,
      midPrice: '1', fillPrice: '1', poolFeeIn: 0n, batcherFeeLovelace: 0n, networkFeeLovelace: 0n, slippageBps: 0, priceImpactBps: 0, poolAfter: null, tsFill: new Date(0) } });
    expect(assumedVenuesTouched([filled('MinswapV2:a')])).toEqual([]);
    expect(assumedVenuesTouched([filled('MinswapV2:a'), filled('Splash:b')])).toEqual(['Splash']);
  });

  // Measured the same way MinswapV2 was, and it CONFIRMED the number rather than correcting it.
  // The grade moved documented -> measured because the old label was the wrong word: SundaeV3.pdf
  // documents a 0.5-1.0 range that neither the library nor the chain uses. Note the fee is a PER-POOL
  // datum value here, not one global constant, which is why the evidence spans several pools.
  it('SundaeSwapV3 is measured, at the same 1.28 ADA, and cites its evidence', () => {
    const c = costsForPoolId('SundaeSwapV3:x');
    expect(c.batcherFeeLovelace).toBe(1_280_000n);
    expect(c.basis).toBe('measured');
    expect(c.source).toMatch(/MEASURED ON CHAIN 2026-09-16/);
    expect(c.readAt).toBe('2026-09-16');
  });

  // Both documented and measured are evidence, so neither is named by the warning; only a guess is.
  it('assumedVenuesTouched flags neither a measured nor a documented venue', () => {
    const filled = (poolId: string): { result: FillResult } => ({ result: { status: 'filled', poolId, unitIn: 'lovelace', amountIn: 1n, unitOut: 'x', amountOut: 1n,
      midPrice: '1', fillPrice: '1', poolFeeIn: 0n, batcherFeeLovelace: 0n, networkFeeLovelace: 0n, slippageBps: 0, priceImpactBps: 0, poolAfter: null, tsFill: new Date(0) } });
    expect(assumedVenuesTouched([filled('SundaeSwapV3:a'), filled('Minswap:b'), filled('MinswapV2:c')])).toEqual([]);
  });

  it('an override becomes assumed with a cli source', () => {
    const c = costsForPoolId('Minswap:x', { batcherFeeLovelace: 1_500_000n });
    expect(c).toMatchObject({ batcherFeeLovelace: 1_500_000n, basis: 'assumed', source: 'cli override' });
  });
  it('assumedVenuesTouched lists distinct assumed venues of filled orders only', () => {
    const filled = (poolId: string): { result: FillResult } => ({ result: { status: 'filled', poolId, unitIn: 'lovelace', amountIn: 1n, unitOut: 'x', amountOut: 1n,
      midPrice: '1', fillPrice: '1', poolFeeIn: 0n, batcherFeeLovelace: 0n, networkFeeLovelace: 0n, slippageBps: 0, priceImpactBps: 0, poolAfter: null, tsFill: new Date(0) } });
    const rejected = { result: { status: 'rejected' as const, reason: 'dust' } };
    expect(assumedVenuesTouched([filled('Splash:a'), filled('Splash:b'), filled('Minswap:c'), rejected, filled('VyFinance:d')])).toEqual(['Splash', 'VyFinance']);
  });

  // Plan 3 Task 6 controller ruling: `Fake` (dev:fake-collector's venue) is not a Dexter venue at
  // all, so it has no VENUE_COSTS entry to be documented or assumed in — but SimExecutor still
  // charges it DEFAULT_COSTS (basis 'assumed'), and the report has to say so rather than silently
  // treating "not in the table" as "not assumed".
  it('treats any non-DexName venue (Fake, synthetic) as assumed too', () => {
    const filled = (poolId: string): { result: FillResult } => ({ result: { status: 'filled', poolId, unitIn: 'lovelace', amountIn: 1n, unitOut: 'x', amountOut: 1n,
      midPrice: '1', fillPrice: '1', poolFeeIn: 0n, batcherFeeLovelace: 0n, networkFeeLovelace: 0n, slippageBps: 0, priceImpactBps: 0, poolAfter: null, tsFill: new Date(0) } });
    expect(assumedVenuesTouched([filled('Fake:SNEK'), filled('Minswap:c')])).toEqual(['Fake']);
    expect(assumedVenuesTouched([filled('synthetic')])).toEqual(['synthetic']);
  });
});
