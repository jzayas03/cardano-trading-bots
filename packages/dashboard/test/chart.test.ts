import type { EquityPoint } from '@ctb/engine';
import { describe, expect, it } from 'vitest';
import { chartHtml, equitySeries } from '../src/chart.js';

const points: EquityPoint[] = [
  { tickTs: new Date('2026-09-06T12:00:00Z'), cashLovelace: 1_000_000_000n, positionBase: 0n, equityLovelace: 1_000_000_000n, equityExecutableLovelace: 1_000_000_000n, price: '0.5' },
  { tickTs: new Date('2026-09-06T12:10:00Z'), cashLovelace: 500_000_000n, positionBase: 900_000n, equityLovelace: 980_000_000n, equityExecutableLovelace: null, price: '0.53' },
];

describe('equitySeries', () => {
  it('gives ts in seconds since epoch, equityAda via adaStr, and null execAda where unpriced', () => {
    const s = equitySeries(points);
    expect(s.ts).toEqual([Math.floor(points[0]!.tickTs.getTime() / 1000), Math.floor(points[1]!.tickTs.getTime() / 1000)]);
    expect(s.equityAda).toEqual([1000, 980]);
    expect(s.execAda).toEqual([1000, null]);
  });

  it('returns empty arrays for no points', () => {
    expect(equitySeries([])).toEqual({ ts: [], equityAda: [], execAda: [] });
  });
});

describe('chartHtml', () => {
  it('contains the div id and instantiates uPlot', () => {
    const html = chartHtml('equity-chart-7', equitySeries(points));
    expect(html).toContain('id="equity-chart-7"');
    expect(html).toContain('new uPlot(');
    expect(html).toContain("getElementById(\"equity-chart-7\")");
  });
});
