import { isDexName, type DexName } from '@ctb/collector';
import type { FillResult } from '@ctb/engine';

/**
 * Per-venue fixed costs of one swap, with provenance. Batcher/agent/scooper fees were read from each
 * venue's own documentation on 2026-09-06 (docs/ops/2026-09-06-m2-report.md §1). A venue whose docs do
 * not state a number is `assumed` at 2 ADA and is named in every report it touches. The network fee is an
 * estimate (0.2 ADA) everywhere; `basis` describes the batcher fee. Lowering a fee makes reported results
 * better, which is exactly why a value with no source is not allowed here (costsProvenance.guard).
 */
export interface VenueCosts {
  batcherFeeLovelace: bigint;
  networkFeeLovelace: bigint;
  basis: 'documented' | 'assumed';
  source: string;
  readAt: string;
}

const NETWORK = 200_000n;
const READ_AT = '2026-09-06';
const MINSWAP_DOC = 'https://docs.minswap.org/courses/how-to-perform-swaps/batcher';

export const DEFAULT_COSTS: VenueCosts = { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'plan-2 assumption', readAt: READ_AT };

export const VENUE_COSTS: Record<DexName, VenueCosts> = {
  Minswap: { batcherFeeLovelace: 0n, networkFeeLovelace: NETWORK, basis: 'documented', source: MINSWAP_DOC, readAt: READ_AT },
  MinswapV2: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'https://docs.minswap.org/courses/how-to-perform-swaps/batcher.md ("previously around 2 ADA per order", read 2026-09-07; no current figure, V1/V2 not distinguished; on-chain check pending)', readAt: READ_AT },
  SundaeSwapV1: { batcherFeeLovelace: 2_500_000n, networkFeeLovelace: NETWORK, basis: 'documented', source: 'SundaeV3.pdf §3 (scooper fee)', readAt: READ_AT },
  SundaeSwapV3: { batcherFeeLovelace: 1_000_000n, networkFeeLovelace: NETWORK, basis: 'documented', source: 'SundaeV3.pdf §4.4.3 (documented range 0.5-1.0 ADA per order; the upper bound is charged here, so reported results err on the expensive side)', readAt: READ_AT },
  MuesliSwap: { batcherFeeLovelace: 950_000n, networkFeeLovelace: NETWORK, basis: 'documented', source: 'https://docs.muesliswap.com', readAt: READ_AT },
  WingRiders: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'https://docs.wingriders.com (amount not stated)', readAt: READ_AT },
  WingRidersV2: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'https://docs.wingriders.com (amount not stated)', readAt: READ_AT },
  VyFinance: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'https://docs.vyfi.io (amount not stated)', readAt: READ_AT },
  Splash: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'https://docs.splash.trade (amount not stated)', readAt: READ_AT },
};

export function venueOf(poolId: string): string {
  return poolId.split(':')[0] ?? '';
}

export function tryCostsForPoolId(poolId: string, overrides?: Partial<Pick<VenueCosts, 'batcherFeeLovelace' | 'networkFeeLovelace'>>): VenueCosts | null {
  const venue = venueOf(poolId);
  if (!isDexName(venue)) return null;
  const base = VENUE_COSTS[venue];
  if (!overrides || (overrides.batcherFeeLovelace === undefined && overrides.networkFeeLovelace === undefined)) return base;
  return { ...base, ...overrides, basis: 'assumed', source: 'cli override', readAt: READ_AT };
}

export function costsForPoolId(poolId: string, overrides?: Partial<Pick<VenueCosts, 'batcherFeeLovelace' | 'networkFeeLovelace'>>): VenueCosts {
  const c = tryCostsForPoolId(poolId, overrides);
  if (!c) throw new Error(`unknown venue in pool id ${poolId}`);
  return c;
}

/**
 * Distinct venues with assumed (never documented) costs among FILLED orders, sorted; the report
 * names them. A `DexName` venue is assumed when its `VENUE_COSTS` entry says so. Any OTHER venue —
 * `synthetic` (the `cpmm_synthetic_depth` fill model's own pool id) or `Fake` (`dev:fake-collector`,
 * Plan 3 Task 6) — has no venue-specific documentation to look up at all; `SimExecutor.costsFor`
 * charges it `DEFAULT_COSTS` (`basis: 'assumed'`), so the report treats it the same way here rather
 * than silently skipping it for not being a name in the venue table.
 */
export function assumedVenuesTouched(orders: Array<{ result: FillResult }>): string[] {
  const out = new Set<string>();
  for (const o of orders) {
    if (o.result.status !== 'filled') continue;
    const v = venueOf(o.result.poolId);
    if (!isDexName(v) || VENUE_COSTS[v].basis === 'assumed') out.add(v);
  }
  return [...out].sort();
}
