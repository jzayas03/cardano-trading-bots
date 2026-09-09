import { describe, expect, it } from 'vitest';
import { opportunity, type OpportunityCandle } from '@ctb/reports';
import { renderOpportunity } from '../src/commands/opportunity.js';

/** Six hourly candles drifting 1% a step: enough to produce windows, nowhere near enough to carry a rate. */
const drifting: OpportunityCandle[] = Array.from({ length: 6 }, (_, i) => ({
  tickTs: new Date(Date.UTC(2026, 8, 6, i)), open: 1, high: 1 + i * 0.03, low: 1, close: 1 + i * 0.03, samples: 4,
}));

const render = (c: OpportunityCandle[]): string =>
  renderOpportunity('NIGHT', opportunity(c, { floorBps: 216, candleIntervalSec: 3600, windowSecs: [7200] })).join('\n');

describe('renderOpportunity never prints a rate the sample cannot carry', () => {
  it('prints the interval and the NOT DECISIVE marker beside every underpowered rate', () => {
    const out = render(drifting);
    // The failure this closes: a bare "11.9%" left this renderer, was pasted into a review document,
    // and read as a finding. It was one window out of fourteen.
    expect(out).toMatch(/95% CI/);
    expect(out).toMatch(/NOT DECISIVE/);
  });

  it('states plainly, once, that nothing on the page is decisive', () => {
    expect(render(drifting)).toMatch(/sample is too small/i);
  });

  it('never emits a bare percentage without a denominator beside it', () => {
    for (const line of renderOpportunity('NIGHT', opportunity(drifting, { floorBps: 216, candleIntervalSec: 3600, windowSecs: [7200] }))) {
      // Every line carrying a % must also carry an "of N", a CI, or be prose. This is the property
      // that makes the figure un-quotable on its own, rather than a convention someone must remember.
      if (/\d\.\d%/.test(line) && !/^\s*[A-Z]/.test(line)) {
        expect(line, `bare rate: ${line}`).toMatch(/ of \d+|95% CI|NOT MEASURED/);
      }
    }
  });
});
