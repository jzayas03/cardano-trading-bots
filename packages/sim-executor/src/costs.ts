import { isDexName, type DexName } from '@ctb/collector/pure';
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
  // The 0 here is what proves Dexter's constant is not a reading of current policy: Dexter writes the
  // IDENTICAL 2 ADA for this venue, which documentation puts at zero. The guard asserts that
  // disagreement on purpose — if it ever stops disagreeing, Dexter has been updated, and that is the
  // moment to re-examine MinswapV2 above.
  Minswap: { batcherFeeLovelace: 0n, networkFeeLovelace: NETWORK, basis: 'documented', source: MINSWAP_DOC, readAt: READ_AT },
  // 2026-09-09: kept at 2 ADA on EVIDENCE, not inertia. Dexter 5.4.10's minswap-v2 adapter hardcodes
  // `batcherFee: 2000000n` (isReturned: false) into the order datum, and offering a fee in the datum
  // is paying it. Minswap's own policy may well be zero since May 2025 — that is a claim about the
  // VENUE; this number is about our SUBMISSION PATH. Lower it only after the datum parameter is
  // overridden at submission (M6 spec §7.2), never before: modelling 176 bps while paying 216
  // overstates every strategy's edge by 40 bps, in the direction that pushes losers through the gate.
  MinswapV2: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'Dexter 5.4.10 minswap-v2.js swapOrderFees() writes batcherFee 2000000n into the datum (read 2026-09-09), so this is what WE would pay regardless of Minswap policy; docs.minswap.org batcher page says only "previously around 2 ADA per order" (read 2026-09-07) and does not distinguish V1/V2. Pinned by dexterWritesTheBatcherFee.guard.test.ts', readAt: READ_AT },
  SundaeSwapV1: { batcherFeeLovelace: 2_500_000n, networkFeeLovelace: NETWORK, basis: 'documented', source: 'SundaeV3.pdf §3 (scooper fee)', readAt: READ_AT },
  // 2026-09-09: raised 1.00 -> 1.28 on the same rule as MinswapV2 — the model follows the SUBMISSION
  // path. Dexter 5.4.10's sundaeswap-v3 adapter writes `protocolFeeDefault = 1280000n` into the
  // order, which is exactly what the M6.1 spike measured on a live quote. The old 1.00 came from the
  // documented 0.5-1.0 range and was described as an upper bound charged so results "err on the
  // expensive side" — it was neither: it sat BELOW what we would actually pay, inverting the
  // conservatism it claimed. That discrepancy is now explained rather than merely flagged.
  SundaeSwapV3: { batcherFeeLovelace: 1_280_000n, networkFeeLovelace: NETWORK, basis: 'documented', source: 'Dexter 5.4.10 sundaeswap-v3.js protocolFeeDefault = 1280000n written into the order (read 2026-09-09), matching the 1.28 ADA measured on a live quote in the M6.1 spike; SundaeV3.pdf §4.4.3 documents a 0.5-1.0 range that the library does not follow. Pinned by dexterWritesTheBatcherFee.guard.test.ts', readAt: READ_AT },
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
