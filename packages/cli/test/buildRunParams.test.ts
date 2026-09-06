import { VENUE_COSTS } from '@ctb/sim-executor';
import { describe, expect, it } from 'vitest';
import { buildRunParams } from '../src/commands/backtest.js';

/**
 * Review finding (Task 10, fix round 1): `backtestCommand` used to record `runs.params.costs`
 * with re-hardcoded literals (`?? 2_000_000n` / `?? 200_000n`) instead of the shared
 * `VENUE_COSTS` table from `@ctb/sim-executor` — a change to a venue's fee would silently
 * drift from what got recorded in run provenance. `buildRunParams` is the extracted pure
 * function so this is testable without a database.
 *
 * Task 1: every venue now carries its own `basis`/`source`/`readAt` (there is no single shared
 * default the whole table shares any more — each row's provenance is its own), so a run's
 * recorded `venues` map must carry those three fields per venue too, not just the two fee amounts.
 */
describe('buildRunParams', () => {
  /**
   * Finding I1: `costs` used to record ONE flat batcher/network pair, which is not what the executor
   * charges — it charges from the per-venue table, with the run's overrides applied on top. A run
   * over a multi-venue window recorded a cost model it never used.
   */
  it('records the whole venue cost table, with provenance, not a single flat pair', () => {
    const params = buildRunParams({ fast: 12, slow: 48 }, {}, 1000, null, {}, 900_000);
    const costs = params.costs as { overrides: Record<string, string>; venues: Record<string, { batcherFeeLovelace: string; networkFeeLovelace: string; basis: string; source: string; readAt: string }> };
    expect(costs.overrides).toEqual({});
    expect(Object.keys(costs.venues).sort()).toEqual(Object.keys(VENUE_COSTS).sort());
    for (const [venue, c] of Object.entries(VENUE_COSTS)) {
      expect(costs.venues[venue], venue).toEqual({
        batcherFeeLovelace: c.batcherFeeLovelace.toString(),
        networkFeeLovelace: c.networkFeeLovelace.toString(),
        basis: c.basis,
        source: c.source,
        readAt: c.readAt,
      });
    }
  });

  it('records only what --batcher-ada / --network-ada actually overrode, beside the table', () => {
    const params = buildRunParams({ fast: 12, slow: 48 }, {}, 1000, null, { batcherFeeLovelace: 1_500_000n }, 900_000);
    const costs = params.costs as { overrides: Record<string, string>; venues: Record<string, { batcherFeeLovelace: string }> };
    expect(costs.overrides, 'only the overridden leg is recorded as an override').toEqual({ batcherFeeLovelace: '1500000' });
    expect(costs.venues.Splash?.batcherFeeLovelace, 'the table is recorded unchanged; the override wins over it at fill time')
      .toBe(VENUE_COSTS.Splash.batcherFeeLovelace.toString());
  });

  it('records the stale-fill bound the run used', () => {
    expect(buildRunParams({ fast: 12 }, {}, 1000, null, {}, 3_600_000).maxGapMs).toBe(3_600_000);
  });

  it('merges strategy defaults with arg params and carries cashAda/depthAda through', () => {
    const params = buildRunParams({ fast: 12, slow: 48 }, { fast: 6 }, 500, 800_000, {}, 900_000);
    expect(params).toMatchObject({ fast: 6, slow: 48, cashAda: 500, depthAda: 800_000 });
  });

  // Plan 3 Task 3: the CLI passes fillModelDetail (e.g. the synthetic-price choice) only for an
  // external-source run; buildRunParams keeps its 6-arg call sites working (Task 4's paper run
  // included) while still recording whatever the 7th arg carries when it is given.
  it('leaves params unchanged when extra is omitted, and merges it in at the top level otherwise', () => {
    expect(buildRunParams({ fast: 12 }, {}, 1000, null, {}, 900_000)).not.toHaveProperty('fillModelDetail');
    const params = buildRunParams({ fast: 12 }, {}, 1000, 800_000, {}, 900_000, { fillModelDetail: { syntheticPrice: 'worst' } });
    expect(params.fillModelDetail).toEqual({ syntheticPrice: 'worst' });
  });
});
