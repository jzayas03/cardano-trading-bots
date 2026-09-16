import { describe, expect, it } from 'vitest';
import type { FillResult } from '@ctb/engine';
import { assumedVenuesTouched, costsForPoolId } from '../src/index.js';

describe('VENUE_COSTS (read from venue docs 2026-09-06, see M2 report §1)', () => {
  it('carries the documented values', () => {
    expect(costsForPoolId('Minswap:x').batcherFeeLovelace).toBe(0n);
    expect(costsForPoolId('SundaeSwapV1:x').batcherFeeLovelace).toBe(2_500_000n);
    // 1.28, not the documented 1.0: the model follows what Dexter writes into the order (#104's rule).
    expect(costsForPoolId('SundaeSwapV3:x').batcherFeeLovelace).toBe(1_280_000n);
    expect(costsForPoolId('MuesliSwap:x').batcherFeeLovelace).toBe(950_000n);
    expect(costsForPoolId('Minswap:x').basis).toBe('documented');
  });
  it('marks the unverified venues as assumed at 2 ADA', () => {
    for (const v of ['WingRiders', 'WingRidersV2', 'VyFinance', 'Splash']) {
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
