import type { EquityPoint } from '@ctb/engine';
import { describe, expect, it } from 'vitest';
import { chartHtml, equitySeries, multiChartHtml, normalisedEquitySeries } from '../src/chart.js';

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

/** Two point arrays sharing a timeline but with very different starting cash — the exact shape
 * `/compare`'s chart needs to prove that a big run and a small run that both double land on one
 * identical curve once normalised. */
const bigRun: EquityPoint[] = [
  { tickTs: new Date('2026-09-06T12:00:00Z'), cashLovelace: 0n, positionBase: 0n, equityLovelace: 1_000_000_000n, equityExecutableLovelace: null, price: '0.5' },
  { tickTs: new Date('2026-09-06T12:10:00Z'), cashLovelace: 0n, positionBase: 0n, equityLovelace: 2_000_000_000n, equityExecutableLovelace: null, price: '0.5' },
];
const smallRun: EquityPoint[] = [
  { tickTs: new Date('2026-09-06T12:00:00Z'), cashLovelace: 0n, positionBase: 0n, equityLovelace: 100_000_000n, equityExecutableLovelace: null, price: '0.5' },
  { tickTs: new Date('2026-09-06T12:10:00Z'), cashLovelace: 0n, positionBase: 0n, equityLovelace: 200_000_000n, equityExecutableLovelace: null, price: '0.5' },
];

describe('normalisedEquitySeries', () => {
  it('two runs of very different cash sizes that both double produce identical pct arrays ending at 100', () => {
    const [big, small] = normalisedEquitySeries([{ label: 'run 1 big', points: bigRun }, { label: 'run 2 small', points: smallRun }]);
    expect(big!.pct).toEqual([0, 100]);
    expect(small!.pct).toEqual([0, 100]);
  });

  it('a run whose first equity is 0 yields all-null pct rather than dividing by zero', () => {
    const zeroStart: EquityPoint[] = [
      { tickTs: new Date('2026-09-06T12:00:00Z'), cashLovelace: 0n, positionBase: 0n, equityLovelace: 0n, equityExecutableLovelace: null, price: '0.5' },
      { tickTs: new Date('2026-09-06T12:10:00Z'), cashLovelace: 0n, positionBase: 0n, equityLovelace: 500_000_000n, equityExecutableLovelace: null, price: '0.5' },
    ];
    const [s] = normalisedEquitySeries([{ label: 'run 3 zero-start', points: zeroStart }]);
    expect(s!.pct).toEqual([null, null]);
  });

  it('drops a run with fewer than two persisted points instead of emitting a degenerate series', () => {
    expect(normalisedEquitySeries([{ label: 'run 4 one-point', points: [points[0]!] }])).toEqual([]);
    expect(normalisedEquitySeries([{ label: 'run 5 no-points', points: [] }])).toEqual([]);
  });

  it('gives ts in unix seconds, matching equitySeries', () => {
    const [s] = normalisedEquitySeries([{ label: 'run 6', points }]);
    expect(s!.ts).toEqual([Math.floor(points[0]!.tickTs.getTime() / 1000), Math.floor(points[1]!.tickTs.getTime() / 1000)]);
  });

  it('a run in the middle of a mixed list is dropped without disturbing the runs around it', () => {
    const series = normalisedEquitySeries([
      { label: 'run 1 big', points: bigRun },
      { label: 'run 4 one-point', points: [points[0]!] },
      { label: 'run 2 small', points: smallRun },
    ]);
    expect(series.map((s) => s.label)).toEqual(['run 1 big', 'run 2 small']);
  });
});

describe('multiChartHtml', () => {
  it('contains the div id, instantiates uPlot, and labels every series', () => {
    const series = normalisedEquitySeries([{ label: 'run 6 buyAndHold', points }, { label: 'run 7 ma-crossover', points }]);
    const html = multiChartHtml('compare-chart', series);
    expect(html).toContain('id="compare-chart"');
    expect(html).toContain('new uPlot(');
    expect(html).toContain("getElementById(\"compare-chart\")");
    expect(html).toContain('run 6 buyAndHold');
    expect(html).toContain('run 7 ma-crossover');
  });

  it('aligns series with different timestamps onto a shared, sorted x-axis, filling a series\' missing timestamp with null', () => {
    const runA: EquityPoint[] = [
      { tickTs: new Date('2026-09-06T12:00:00Z'), cashLovelace: 0n, positionBase: 0n, equityLovelace: 1_000_000_000n, equityExecutableLovelace: null, price: '0.5' },
      { tickTs: new Date('2026-09-06T12:10:00Z'), cashLovelace: 0n, positionBase: 0n, equityLovelace: 1_100_000_000n, equityExecutableLovelace: null, price: '0.5' },
    ];
    const runB: EquityPoint[] = [
      { tickTs: new Date('2026-09-06T12:05:00Z'), cashLovelace: 0n, positionBase: 0n, equityLovelace: 500_000_000n, equityExecutableLovelace: null, price: '0.5' },
      { tickTs: new Date('2026-09-06T12:10:00Z'), cashLovelace: 0n, positionBase: 0n, equityLovelace: 600_000_000n, equityExecutableLovelace: null, price: '0.5' },
    ];
    const series = normalisedEquitySeries([{ label: 'A', points: runA }, { label: 'B', points: runB }]);
    const html = multiChartHtml('compare-chart', series);
    const dataMatch = html.match(/\}, (\[.*\]), document\.getElementById\(/s);
    expect(dataMatch).not.toBeNull();
    const data = JSON.parse(dataMatch![1]!) as Array<Array<number | null>>;

    const tsA = Math.floor(runA[0]!.tickTs.getTime() / 1000);
    const tsB = Math.floor(runB[0]!.tickTs.getTime() / 1000);
    const tsShared = Math.floor(runA[1]!.tickTs.getTime() / 1000);
    expect(data[0]).toEqual([tsA, tsB, tsShared]); // sorted ascending: 12:00, 12:05, 12:10

    const idxTsB = data[0]!.indexOf(tsB);
    const idxTsA = data[0]!.indexOf(tsA);
    expect(data[1]![idxTsB]).toBeNull(); // series A has no point at B's 12:05 timestamp
    expect(data[2]![idxTsA]).toBeNull(); // series B has no point at A's 12:00 timestamp
  });

  it('renders a valid (empty) chart for an empty series list', () => {
    const html = multiChartHtml('compare-chart', []);
    expect(html).toContain('new uPlot(');
    expect(html).toContain('id="compare-chart"');
  });

  /**
   * Task 1 review finding: `jsonForScript` (the private helper that escapes `<` to `<` before
   * interpolating JSON into the inline `<script>`) was previously pinned only INCIDENTALLY — by a
   * fixture label that happened to contain the substring `<script>` (`normalisedEquitySeries` built
   * from a run's own `strategyId`, so `series[].label` is the one field here that is genuinely
   * database-derived). A payload like `a</script><b` — a real `</script>` immediately followed by
   * more attacker/data-controlled content, rather than a whole tag on its own — was never exercised
   * directly. This test targets `jsonForScript` head-on, through the one field it actually escapes.
   */
  it('jsonForScript escapes every "<" (not just a whole "<script>" tag) so a label like "a</script><b" cannot close the inline script early', () => {
    const series = normalisedEquitySeries([{ label: 'a</script><b', points }]);
    const html = multiChartHtml('compare-chart', series);
    expect(html).not.toContain('</script><b');
    // Only "<" is escaped (to "<"), never ">" — so the ">" right after "script" stays literal;
    // what makes this safe is that BOTH "<" characters (the one opening "</script" and the one before
    // "b") are gone, not that the substring is unrecognisable.
    expect(html).toContain('a\\u003c/script>\\u003cb');
    // The real closing </script> (uPlot.iife's own, and this file's inline block) must appear exactly
    // once after the label — a literal "</script>" smuggled in from the label would have added a second.
    expect((html.match(/<\/script>/g) ?? []).length).toBe(1);
  });
});
