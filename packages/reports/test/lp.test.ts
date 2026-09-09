import { describe, expect, it } from 'vitest';
import { lpEntryRows, lpEntrySummary, type LpCandle } from '../src/index.js';

const c = (hour: number, close: string, netFlowQuote: bigint | null = 0n): LpCandle => ({
  tickTs: new Date(Date.UTC(2026, 8, 6, hour)), close, feeBps: 30,
  tvlLovelace: 1_000_000_000_000n, netFlowQuote,
});

describe('LP entry sensitivity', () => {
  it('computes the textbook figures for a doubling, against every benchmark at once', () => {
    const [row] = lpEntryRows([c(0, '0.1'), c(1, '0.2')]);
    expect(row!.priceRatio).toBe(2);
    // Impermanent loss vs the 50/50 basket: 2*sqrt(2)/3 - 1.
    expect(row!.ilPct).toBe(-5.72);
    // The accumulation metric: LP value restated in TOKENS vs holding the token. 1/sqrt(2) - 1.
    // The same number is the LP's own token count against its start — both are sqrt(p0/p1).
    expect(row!.vsHoldTokensPct).toBe(-29.29);
    // Fees needed to break even against holding tokens: sqrt(2) - 1.
    expect(row!.breakEvenFeePct).toBe(41.42);
  });

  it('is symmetric in log price for IL and inverted for the token metric', () => {
    const up = lpEntryRows([c(0, '0.1'), c(1, '0.2')])[0]!;
    const down = lpEntryRows([c(0, '0.2'), c(1, '0.1')])[0]!;
    // The headline IL is the SAME for a halving and a doubling...
    expect(down.ilPct).toBe(up.ilPct);
    // ...while the number that matters for accumulation flips sign and is five times larger.
    expect(up.vsHoldTokensPct).toBe(-29.29);
    expect(down.vsHoldTokensPct).toBe(41.42);
  });

  it('reads exactly zero when the price returns to its entry, whatever it did in between', () => {
    // IL depends ONLY on the endpoints. A round trip through 0.2 costs nothing at the exit.
    const rows = lpEntryRows([c(0, '0.1'), c(1, '0.2'), c(2, '0.05'), c(3, '0.1')]);
    expect(rows[0]!.ilPct).toBe(0);
    expect(rows[0]!.vsHoldTokensPct).toBe(0);
    expect(rows[0]!.breakEvenFeePct).toBe(0);
  });

  it('a 50% rise costs 2% in ADA terms and 18% of the token count', () => {
    const [row] = lpEntryRows([c(0, '0.1'), c(1, '0.15')]);
    expect(row!.ilPct).toBe(-2.02);
    expect(row!.vsHoldTokensPct).toBe(-18.35);
  });

  it('emits one row per entry candle, all measured against the LAST candle', () => {
    const rows = lpEntryRows([c(0, '0.1'), c(1, '0.11'), c(2, '0.12')]);
    expect(rows).toHaveLength(2); // the exit candle is not an entry
    expect(rows.map((r) => r.entryPrice)).toEqual(['0.1', '0.11']);
    for (const r of rows) expect(r.exitPrice).toBe('0.12');
  });

  it('bounds fees from BELOW using net flow, and never claims it is volume', () => {
    // 1% of TVL of net flow at 30 bps = 0.003% per tick. Two ticks after entry = 0.006%.
    const flow = 10_000_000_000n; // 1% of the 1,000,000 ADA TVL
    const rows = lpEntryRows([c(0, '0.1'), c(1, '0.1', flow), c(2, '0.1', -flow)]);
    expect(rows[0]!.feeLowerBoundPct).toBeCloseTo(0.006, 6);
    // Sign does not matter: a sell earns the same fee as a buy.
    expect(rows[1]!.feeLowerBoundPct).toBeCloseTo(0.003, 6);
  });

  it('skips a candle whose price cannot be read rather than inventing a ratio', () => {
    const rows = lpEntryRows([c(0, '0.1'), c(1, 'NaN'), c(2, '0.1')]);
    expect(rows.map((r) => r.entryPrice)).toEqual(['0.1']);
    expect(lpEntryRows([c(0, '0.1'), c(1, '0')])).toEqual([]); // unreadable EXIT: nothing measurable
  });

  it('summarises best, worst, median and the spread that answers "does entry matter"', () => {
    // Entries at 0.10, 0.12, 0.08; exit 0.10. Entering at the high is best for an LP (price fell
    // back to it), entering at the low is worst — the reverse of buying, and the point of the sweep.
    const s = lpEntrySummary(lpEntryRows([c(0, '0.10'), c(1, '0.12'), c(2, '0.08'), c(3, '0.10')]));
    expect(s).not.toBeNull();
    expect(s!.entries).toBe(3);
    expect(s!.best.entryPrice).toBe('0.12');
    expect(s!.worst.entryPrice).toBe('0.08');
    expect(s!.median.entryPrice).toBe('0.10');
    expect(s!.spreadPct).toBe(Math.round((s!.best.vsHoldTokensPct - s!.worst.vsHoldTokensPct) * 100) / 100);
    expect(s!.exitPrice).toBe('0.10');
  });

  it('THE FINDING: entry timing is worth HALF the price range, and no more', () => {
    // 1/sqrt(1+x) - 1 ~= -x/2 for small x, so the spread between the best and worst entry over a
    // window is half of how far the price travelled in it. Measured live on NIGHT 2026-09-06..08:
    // a 7.84% range produced a 3.84-point spread. That is an identity, not a result -- which is why
    // it answers the question. "Knowing the entry price" is not a separate LP skill; it is price
    // forecasting, paid at half weight. Anyone who can time entry 5% better gains 2.5%, exactly.
    const lo = '0.10';
    const hi = '0.1078'; // +7.8%, NIGHT's observed range
    const s = lpEntrySummary(lpEntryRows([c(0, hi), c(1, lo), c(2, lo)]))!;
    const rangePct = (Number(hi) / Number(lo) - 1) * 100;
    expect(rangePct).toBeCloseTo(7.8, 6);
    // Half, and always a shade UNDER it: the square root is convex, so the linearisation overstates.
    // Asserted as a ratio rather than an absolute tolerance, because the gap grows with the range
    // and a fixed epsilon would quietly stop testing anything on a wider window.
    const vsHalf = s.spreadPct / (rangePct / 2);
    expect(vsHalf).toBeGreaterThan(0.95);
    expect(vsHalf).toBeLessThan(1);
  });

  it('is null, not an empty summary, when there is nothing to summarise', () => {
    expect(lpEntrySummary([])).toBeNull();
    expect(lpEntryRows([c(0, '0.1')])).toEqual([]); // one candle is not a window
    expect(lpEntryRows([])).toEqual([]);
  });

  it('counts fee_bps anomalies instead of silently pricing them at zero', () => {
    // Two rows in the live NIGHT corpus carry fee_bps = 0 against a 30 bps pool. They contribute no
    // fee to the lower bound, which is correct-but-invisible unless the count is surfaced.
    const bad = { ...c(1, '0.1', 5_000_000_000n), feeBps: 0 };
    const s = lpEntrySummary(lpEntryRows([c(0, '0.1'), bad, c(2, '0.1')]));
    expect(s!.feeBpsAnomalies).toBe(1);
  });
});
