import { DEFAULT_COSTS } from '@ctb/sim-executor';
import { describe, expect, it } from 'vitest';
import { buildRunParams } from '../src/commands/backtest.js';

/**
 * Review finding (Task 10, fix round 1): `backtestCommand` used to record `runs.params.costs`
 * with re-hardcoded literals (`?? 2_000_000n` / `?? 200_000n`) instead of the shared
 * `DEFAULT_COSTS` from `@ctb/sim-executor` — a change to the shared default would silently
 * drift from what got recorded in run provenance. `buildRunParams` is the extracted pure
 * function so this is testable without a database.
 */
describe('buildRunParams', () => {
  it('records DEFAULT_COSTS when no cost overrides are given', () => {
    const params = buildRunParams({ fast: 12, slow: 48 }, {}, 1000, null, {}, 900_000);
    expect(params.costs).toEqual({
      batcherFeeLovelace: DEFAULT_COSTS.batcherFeeLovelace.toString(),
      networkFeeLovelace: DEFAULT_COSTS.networkFeeLovelace.toString(),
    });
  });

  it('records an overridden batcher fee in lovelace when --batcher-ada is given', () => {
    const params = buildRunParams({ fast: 12, slow: 48 }, {}, 1000, null, { batcherFeeLovelace: 1_500_000n }, 900_000);
    expect(params.costs).toEqual({
      batcherFeeLovelace: '1500000',
      networkFeeLovelace: DEFAULT_COSTS.networkFeeLovelace.toString(),
    });
  });

  it('merges strategy defaults with arg params and carries cashAda/depthAda through', () => {
    const params = buildRunParams({ fast: 12, slow: 48 }, { fast: 6 }, 500, 800_000, {}, 900_000);
    expect(params).toMatchObject({ fast: 6, slow: 48, cashAda: 500, depthAda: 800_000 });
  });
});
