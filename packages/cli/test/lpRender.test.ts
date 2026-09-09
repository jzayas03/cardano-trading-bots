import { describe, expect, it } from 'vitest';
import type { LpEntryRow, LpEntrySummary } from '@ctb/reports';
import { renderLp } from '../src/commands/lp.js';

const row = (over: Partial<LpEntryRow> = {}): LpEntryRow => ({
  entryTs: new Date('2026-09-07T15:30:00Z'), entryPrice: '0.106388', exitPrice: '0.102249',
  priceRatio: 0.961, ilPct: -0.02, vsHoldTokensPct: 2, breakEvenFeePct: -1.96,
  feeLowerBoundPct: 0.0188, feeBpsAnomalies: 0, ...over,
});
const summary = (median: LpEntryRow): LpEntrySummary => ({
  entries: 161, exitTs: new Date('2026-09-08T19:30:00Z'), exitPrice: '0.102249',
  best: row({ vsHoldTokensPct: 3.56 }), worst: row({ vsHoldTokensPct: -0.28 }), median,
  spreadPct: 3.84, feeBpsAnomalies: 0,
});

describe('renderLp', () => {
  it('never annualises a NEGATIVE break-even fee — it means the position is already ahead', () => {
    // The bug this pins: -1.96% break-even over 1.17 days rendered as "-367.9% APR", which reads as
    // a catastrophic requirement when it means the exact opposite — no fee at all is needed.
    const out = renderLp('NIGHT', 'pool', summary(row({ breakEvenFeePct: -1.96 })), 1.17, 0).join('\n');
    expect(out).not.toMatch(/-\d+(\.\d+)?% APR/);
    expect(out).toMatch(/already ahead of holding by 1\.96% before any fees/);
  });

  it('annualises a POSITIVE break-even fee, which is a real requirement', () => {
    const out = renderLp('NIGHT', 'pool', summary(row({ breakEvenFeePct: 2 })), 73, 0).join('\n');
    expect(out).toMatch(/needs 2\.00%/);
    expect(out).toMatch(/10\.0% APR/); // 2% over 73 days
  });

  it('annualises the fee LOWER BOUND so it can be read beside a yield estimate', () => {
    const out = renderLp('NIGHT', 'pool', summary(row({ feeLowerBoundPct: 0.0188 })), 1.17, 0).join('\n');
    expect(out).toMatch(/at least 0\.0188%/);
    expect(out).toMatch(/5\.9% APR/); // 0.0188 * 365 / 1.17
    expect(out).toMatch(/LOWER BOUND/);
  });

  it('says how many candles it dropped, and why, whenever a series is spliced', () => {
    const out = renderLp('NIGHT', 'pool', summary(row()), 1.9, 15).join('\n');
    expect(out).toMatch(/15 candles on other pools EXCLUDED/);
    expect(renderLp('NIGHT', 'pool', summary(row()), 1.9, 0).join('\n')).not.toMatch(/EXCLUDED/);
  });
});
