import { isDexName, VENUE_NAMES, type DexName } from '@ctb/collector';

/**
 * ASSUMPTION (Plan 2, 2026-09-06): every venue is modelled with a 2 ADA batcher/agent/scooper fee and a
 * 0.2 ADA network fee. Real fees differ per DEX and change; Task 11 checks each venue's published fee and
 * records the values actually used in runs.params. Override per run with --batcher-ada / --network-ada.
 */
export interface VenueCosts { batcherFeeLovelace: bigint; networkFeeLovelace: bigint }

export const DEFAULT_COSTS: VenueCosts = { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n };

export const VENUE_COSTS: Record<DexName, VenueCosts> = Object.fromEntries(VENUE_NAMES.map((v) => [v, DEFAULT_COSTS])) as Record<DexName, VenueCosts>;

export function costsForPoolId(poolId: string, overrides?: Partial<VenueCosts>): VenueCosts {
  const venue = poolId.split(':')[0] ?? '';
  if (!isDexName(venue)) throw new Error(`unknown venue in pool id ${poolId}`);
  return { ...VENUE_COSTS[venue], ...overrides };
}
