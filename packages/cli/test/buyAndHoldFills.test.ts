import { describe, expect, it } from 'vitest';
import { buyAndHold, runEngine, type Candle } from '@ctb/engine';
import { SimExecutor } from '@ctb/sim-executor';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const c = (i: number, close: string): Candle => ({
  tickTs: new Date(Date.UTC(2026, 8, 6, 0, 5 * i)), open: close, high: close, low: close, close, volumeQuote: '1',
  poolId: null, poolType: null, feeBps: null, closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null,
});

/**
 * The baseline at its DEFAULT params must actually get into the market against the real executor
 * and its default (assumed, 2.2 ADA) fees. At fraction 1 it never did: 4,969 intents, 4,969
 * `insufficient cash` rejections, and a clean-looking 0% (SNEK external comparison, 2026-09-07).
 */
describe('buy-and-hold fills at its default params against the real executor', () => {
  it('fills once on the second candle and then holds, with no warning on the run', async () => {
    const executor = new SimExecutor({ decimals: 0, baseUnit: 'tok', fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: 800_000_000_000n }, maxGapMs: 900_000 });
    const r = await runEngine({ feed: [c(0, '0.002'), c(1, '0.002'), c(2, '0.002'), c(3, '0.002')], strategy: buyAndHold, executor,
      initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log });
    expect(r.summary.filled).toBe(1);
    expect(r.summary.intents).toBe(1);
    expect(r.summary.rejected).toBe(0);
    expect(r.summary.warnings).toEqual([]);
    expect(r.final.positionBase).toBeGreaterThan(0n);
    // 1000 ADA - 990 ADA in - 2.2 ADA fees
    expect(r.final.cashLovelace).toBe(1_000_000_000n - 990_000_000n - 2_200_000n);
  });
  it('at fraction 1 it is rejected on every candle and the run says so', async () => {
    const executor = new SimExecutor({ decimals: 0, baseUnit: 'tok', fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: 800_000_000_000n }, maxGapMs: 900_000 });
    const r = await runEngine({ feed: [c(0, '0.002'), c(1, '0.002'), c(2, '0.002'), c(3, '0.002')], strategy: buyAndHold, params: { fraction: 1 }, executor,
      initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log });
    expect(r.summary.filled).toBe(0);
    // 4 decisions: 3 refused for cash, and the last candle's has no t+1 to settle on.
    expect(r.summary.warnings).toEqual(['strategy buy-and-hold emitted 4 intents and none filled (insufficient cash x3, no t+1 candle x1)']);
  });
});
