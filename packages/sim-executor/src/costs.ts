import { isDexName, VENUE_NAMES, type DexName } from '@ctb/collector';

/**
 * ASSUMPTION (Plan 2, 2026-09-06): every venue is modelled with a 2 ADA batcher/agent/scooper fee and a
 * 0.2 ADA network fee. Real fees differ per DEX and change; Task 11 checks each venue's published fee and
 * records the values actually used in runs.params. Override per run with --batcher-ada / --network-ada.
 */
export interface VenueCosts { batcherFeeLovelace: bigint; networkFeeLovelace: bigint }

export const DEFAULT_COSTS: VenueCosts = { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n };

export const VENUE_COSTS: Record<DexName, VenueCosts> = Object.fromEntries(VENUE_NAMES.map((v) => [v, DEFAULT_COSTS])) as Record<DexName, VenueCosts>;

/** The venue half of a `<dex>:<identifier>` pool id, or '' when there is no prefix. */
export function venueOf(poolId: string): string {
  return poolId.split(':')[0] ?? '';
}

/**
 * Null when the venue prefix is not one we have a cost table for. The executor needs this shape
 * rather than an exception: a pool we cannot cost is one rejected order, counted and reported with
 * every other rejection, not a thrown error that ends the whole run (finding M1).
 */
export function tryCostsForPoolId(poolId: string, overrides?: Partial<VenueCosts>): VenueCosts | null {
  const venue = venueOf(poolId);
  if (!isDexName(venue)) return null;
  return { ...VENUE_COSTS[venue], ...overrides };
}

/** Throwing variant, for callers configuring a run up front where an unknown venue IS a config error. */
export function costsForPoolId(poolId: string, overrides?: Partial<VenueCosts>): VenueCosts {
  const costs = tryCostsForPoolId(poolId, overrides);
  if (!costs) throw new Error(`unknown venue in pool id ${poolId}`);
  return costs;
}
