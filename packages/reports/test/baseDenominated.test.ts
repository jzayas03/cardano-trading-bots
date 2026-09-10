import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '@ctb/engine';
import { summarizeRun } from '../src/index.js';

/** `equityLovelace` is the total (cash + position marked at `price`), so the cash/position split is
 * deliberately varied in one test below to prove the base figures do not depend on it. */
const eq = (equityLovelace: bigint, price: string, hour = 0, cash = 0n, pos = 0n): EquityPoint => ({
  tickTs: new Date(Date.UTC(2026, 8, 6, hour)),
  cashLovelace: cash, positionBase: pos, equityLovelace, equityExecutableLovelace: null, price,
});

describe('base-token-denominated return', () => {
  it('restates total equity in whole base tokens, six places', () => {
    // 1000 ADA at 0.002 ADA/token is 500,000 tokens; 1300 ADA at 0.0024 is 541,666.666666.
    const s = summarizeRun([eq(1_000_000_000n, '0.002', 0), eq(1_300_000_000n, '0.0024', 1)], []);
    expect(s.startBaseTokens).toBe('500000.000000');
    expect(s.endBaseTokens).toBe('541666.666666');
    expect(s.returnBasePct).toBe(8.33);
    expect(s.returnPct).toBe(30); // the ADA number, for contrast
  });

  it('reads ZERO for a price move that bought no extra tokens — the whole point of the column', () => {
    // +20% in ADA, entirely because the token rose 20%. In tokens, nothing happened.
    const s = summarizeRun([eq(1_000_000_000n, '0.002', 0), eq(1_200_000_000n, '0.0024', 1)], []);
    expect(s.returnPct).toBe(20);
    expect(s.returnBasePct).toBe(0);
  });

  it('equals the ADA return exactly when the price did not move', () => {
    // The invariant: base return is the ADA return deflated by the price move, so at a flat price
    // the two must agree to the last place, or one of them is computed wrong.
    for (const [start, end] of [[1_000_000_000n, 1_100_000_000n], [1_000_000_000n, 900_000_000n], [777_000_000n, 777_000_000n]] as const) {
      const s = summarizeRun([eq(start, '0.002', 0), eq(end, '0.002', 1)], []);
      expect(s.returnBasePct).toBe(s.returnPct);
    }
  });

  it('goes negative when the tokens shrink even as ADA grows', () => {
    // +5% in ADA while the token rose 20%: in tokens this lost 12.5%.
    const s = summarizeRun([eq(1_000_000_000n, '0.002', 0), eq(1_050_000_000n, '0.0024', 1)], []);
    expect(s.returnPct).toBe(5);
    expect(s.returnBasePct).toBe(-12.5);
  });

  it('does not depend on the cash/position split, only on total equity and price', () => {
    // Decimals cancel and so does the split: this is total value RESTATED in tokens, not tokens held.
    const allCash = summarizeRun([eq(1_000_000_000n, '0.002', 0, 1_000_000_000n, 0n), eq(1_300_000_000n, '0.0024', 1, 1_300_000_000n, 0n)], []);
    const allPos = summarizeRun([eq(1_000_000_000n, '0.002', 0, 0n, 500_000n), eq(1_300_000_000n, '0.0024', 1, 0n, 500_000n)], []);
    // Anchored to literals as well as to each other: comparing the two runs ALONE passes vacuously
    // while both sides are undefined, which is exactly how this test read before the code existed.
    expect(allCash.startBaseTokens).toBe('500000.000000');
    expect(allCash.returnBasePct).toBe(8.33);
    expect(allPos.startBaseTokens).toBe(allCash.startBaseTokens);
    expect(allPos.endBaseTokens).toBe(allCash.endBaseTokens);
    expect(allPos.returnBasePct).toBe(allCash.returnBasePct);
  });

  it('is null, never 0, when the price is unreadable at either end', () => {
    // A zero or unparseable price makes the restatement UNMEASURABLE. Reporting 0% would read as
    // "the token count did not move", which is a claim nothing here can support.
    for (const bad of ['0', '0.000000000000000000', '', 'NaN', '-0.001']) {
      const atEnd = summarizeRun([eq(1_000_000_000n, '0.002', 0), eq(1_300_000_000n, bad, 1)], []);
      expect(atEnd.returnBasePct, `end price ${JSON.stringify(bad)}`).toBeNull();
      expect(atEnd.endBaseTokens, `end price ${JSON.stringify(bad)}`).toBeNull();
      const atStart = summarizeRun([eq(1_000_000_000n, bad, 0), eq(1_300_000_000n, '0.0024', 1)], []);
      expect(atStart.returnBasePct, `start price ${JSON.stringify(bad)}`).toBeNull();
      expect(atStart.startBaseTokens, `start price ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('is null on fewer than two points or a zero start, exactly where returnPct is', () => {
    const one = summarizeRun([eq(1_000_000_000n, '0.002', 0)], []);
    expect(one.returnPct).toBeNull();
    expect(one.returnBasePct).toBeNull();
    expect(one.startBaseTokens).toBe('500000.000000'); // a single point still restates
    expect(summarizeRun([], []).startBaseTokens).toBeNull();
    const zeroStart = summarizeRun([eq(0n, '0.002', 0), eq(1_000_000_000n, '0.002', 1)], []);
    expect(zeroStart.returnPct).toBeNull();
    expect(zeroStart.returnBasePct).toBeNull();
  });
});

describe('pool fees are kept in native units', () => {
  const order = (side: 'buy' | 'sell', poolFeeIn: bigint) => ({
    seq: 1, tsIntent: new Date(0), intent: { side, amountIn: 1n, reason: 'x' },
    result: {
      status: 'filled' as const, poolId: 'p', unitIn: side === 'buy' ? 'lovelace' : 'tok', amountIn: 1n,
      unitOut: side === 'buy' ? 'tok' : 'lovelace', amountOut: 1n, midPrice: '1', fillPrice: '1',
      poolFeeIn, batcherFeeLovelace: 0n, networkFeeLovelace: 0n, slippageBps: 0, priceImpactBps: 0,
      poolAfter: null, tsFill: new Date(0),
    },
  });

  it('never adds a buy\'s lovelace fee to a sell\'s token fee', () => {
    // The defect: `poolFeeIn` is charged on the order INPUT, so one running total summed lovelace
    // and token subunits into a number printed on every report. There is no rate that makes that
    // sum mean anything, and the two are now reported separately and never combined.
    const s = summarizeRun([], [order('buy', 1_500_000n), { ...order('sell', 42n), seq: 2 }]);
    expect(s.poolFeesInLovelace).toBe(1_500_000n);
    expect(s.poolFeesInBase).toBe(42n);
    expect(s).not.toHaveProperty('poolFeesIn');
  });
});
