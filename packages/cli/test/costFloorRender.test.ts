/**
 * Rendering properties for `cost-floor`. The numbers are tested in @ctb/reports; what is asserted
 * here is what a human can and cannot be shown -- in the style of opportunityRender's "never a bare
 * percentage" test.
 */
import type { CostDistribution, ExclusionRecord } from '@ctb/reports';
import { describe, expect, it } from 'vitest';
import { renderCostFloor } from '../src/commands/costFloor.js';

const ADA = 1_000_000n;

function dist(over: Partial<CostDistribution> = {}): CostDistribution {
  return {
    poolId: 'MinswapV2:deadbeef',
    venue: 'MinswapV2',
    sizeBucketLovelace: 1_000n * ADA,
    verdict: 'sufficient',
    n: 120,
    firstTs: new Date('2026-09-06T00:00:00Z'),
    lastTs: new Date('2026-09-16T00:00:00Z'),
    p50: 101.5,
    p75: 110.25,
    p90: 128.75,
    floorBps: 128.75,
    basis: 'measured',
    medianTvlLovelace: 500_000n * ADA,
    ...over,
  };
}

const PROV = {
  since: '2026-09-06T00:00:00Z',
  minObservations: 30,
  sizes: [100n * ADA, 1_000n * ADA],
  firstTs: new Date('2026-09-06T00:00:00Z'),
  lastTs: new Date('2026-09-16T00:00:00Z'),
  venuesUsed: [{ venue: 'MinswapV2', batcherAda: '2.00', basis: 'measured', readAt: '2026-09-16' }],
};

const render = (d: CostDistribution[], e: ExclusionRecord[] = []) => renderCostFloor(d, e, PROV).join('\n');

describe('renderCostFloor', () => {
  it('never prints a bps figure without its n beside it', () => {
    const text = render([dist()]);
    const row = text.split('\n').find((l) => l.includes('MinswapV2:deadbeef') && l.includes('128.8'))!;
    expect(row).toContain('120');
  });

  it('an insufficient route renders NO percentile at all', () => {
    const text = render([dist({ verdict: 'insufficient', n: 7, p50: null, p75: null, p90: null, floorBps: null })]);
    expect(text).toContain('n=7 of 30 required');
    expect(text).not.toContain('128.8');
    expect(text).toMatch(/NOT ENOUGH OBSERVATIONS/);
  });

  it('says the figures are MODELLED, not realised', () => {
    expect(render([dist()])).toMatch(/MODELLED, not realised/);
  });

  it('states the headline is p90 and why', () => {
    expect(render([dist()])).toMatch(/headline floor\s+p90/);
  });

  it('emits the exclusions section EVEN WHEN EMPTY (FR-017)', () => {
    expect(render([dist()], [])).toContain('EXCLUDED FROM EXECUTION (0)');
  });

  it('lists each exclusion with its reason and what it gave up', () => {
    const ex: ExclusionRecord[] = [{ venue: 'Splash', reason: 'varies-by-pool', detail: 'take varies BY POOL', snapshotsAvailable: 42 }];
    const text = render([dist()], ex);
    expect(text).toContain('Splash');
    expect(text).toContain('varies-by-pool');
    expect(text).toContain('42 snapshots given up');
    expect(text).toContain('take varies BY POOL');
  });

  it('never prints a single global floor figure', () => {
    const text = render([dist(), dist({ poolId: 'MinswapV2:other', p90: 300, floorBps: 300 })]);
    // Every reported floor is attached to a named pool; no row stands for a venue or the market.
    for (const line of text.split('\n')) {
      if (/\d+\.\d\s*$/.test(line) && !line.includes('MinswapV2:')) {
        expect(line).not.toMatch(/FLOOR|p90/);
      }
    }
    expect(text).not.toMatch(/^\s*(overall|global|all venues)/im);
  });

  it('carries the provenance a figure needs to be re-derived', () => {
    const text = render([dist()]);
    expect(text).toContain('basis=measured');
    expect(text).toContain('readAt=2026-09-16');
    expect(text).toContain('n >= 30');
  });
});
