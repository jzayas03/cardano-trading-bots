import { isDexName, type DexName } from '@ctb/collector/pure';
import type { FillResult } from '@ctb/engine';

/**
 * Per-venue fixed costs of one swap, with provenance. Batcher/agent/scooper fees were read from each
 * venue's own documentation on 2026-09-06 (docs/ops/2026-09-06-m2-report.md §1). A venue whose docs do
 * not state a number is `assumed` at 2 ADA and is named in every report it touches. The network fee is an
 * estimate (0.2 ADA) everywhere; `basis` describes the batcher fee. Lowering a fee makes reported results
 * better, which is exactly why a value with no source is not allowed here (costsProvenance.guard).
 *
 * THREE GRADES, in ascending order of what they are worth:
 *   `assumed`    - no usable figure; charged 2 ADA and NAMED in every report that touches it.
 *   `documented` - the venue's own page or paper states it. Better than a guess, and still only a claim.
 *   `measured`   - read off the chain: live order datums carrying the value the validator enforces.
 *
 * `measured` outranks `documented` on purpose, and the reason is Principle I. Documentation describes
 * a venue's intent; the datum describes what our transaction will actually pay. On 2026-09-16 those
 * two disagreed outright — docs.minswap.org said every batcher fee was removed in May 2025 while all
 * four live V2 orders sampled paid 2 ADA. A vocabulary that cannot say "we went and looked" would
 * have forced that reading to be filed as a guess, one word away from being promoted to the claim it
 * disproves. `measured` must cite the reading and its dated note; the guard refuses it otherwise.
 */
export interface VenueCosts {
  batcherFeeLovelace: bigint;
  networkFeeLovelace: bigint;
  basis: 'documented' | 'assumed' | 'measured';
  source: string;
  readAt: string;
}

const NETWORK = 200_000n;
const READ_AT = '2026-09-06';

export const DEFAULT_COSTS: VenueCosts = { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'plan-2 assumption', readAt: READ_AT };

export const VENUE_COSTS: Record<DexName, VenueCosts> = {
  // 2026-09-16: was 0n on the documentation, and the chain refuted it. This entry used to argue that
  // Dexter was STALE because it writes 2 ADA where the docs say zero. Thirteen live V1 fulfilments
  // say Dexter was RIGHT and the documentation was wrong, exactly as it was for V2. The lesson is
  // Principle I in one line: the submission path is the authority.
  Minswap: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'measured', source: 'MEASURED ON CHAIN 2026-09-16: 13 of 13 live V1 fulfilments reconcile to exactly 2.000000 ADA per order with ZERO variance, identity sum(nets) = -txFee exact in every one. The batcher nets ~1.23 and pays ~0.77 in tx fee. Fee-taker identified by tx_info.collateral_inputs, because a Plutus spend needs collateral and the batcher is the only party posting it - the largest positive net is the USER. docs.minswap.org still says all batcher fees were removed in May 2025; the V1 contract does not implement that, the same way the V2 contract does not. Method and raw evidence: docs/ops/2026-09-16-documented-venues-measured.md', readAt: '2026-09-16' },
  // 2026-09-16: no longer an inference. Four live mainnet orders were read and every one carries
  // 2 ADA in the datum the validator enforces, so this is a MEASUREMENT of the chain, not a reading
  // of Dexter. Minswap's docs say all batcher fees were removed in May 2025; the V2 order contract
  // disagrees, and the contract is the one that takes the money. See
  // docs/ops/2026-09-16-minswap-v2-batcher-fee.md for the method, which is repeatable and free.
  // 2026-09-09: kept at 2 ADA on EVIDENCE, not inertia. Dexter 5.4.10's minswap-v2 adapter hardcodes
  // `batcherFee: 2000000n` (isReturned: false) into the order datum, and offering a fee in the datum
  // is paying it. Minswap's own policy may well be zero since May 2025 — that is a claim about the
  // VENUE; this number is about our SUBMISSION PATH. Lower it only after the datum parameter is
  // overridden at submission (M6 spec §7.2), never before: modelling 176 bps while paying 216
  // overstates every strategy's edge by 40 bps, in the direction that pushes losers through the gate.
  MinswapV2: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'measured', source: 'MEASURED ON CHAIN 2026-09-16: four live mainnet V2 orders at block 13949171 (epoch 655) all carry batcherFee 2000000 in top-level datum field 7 — txs 1bbf64d2, 1dfbf2c8, f14c1813, 1a784066; two of them are a round swap plus exactly 4 ADA (2 batcher, not returned + 2 deposit, returned), which is the same arithmetic Dexter builds. docs.minswap.org claims ALL batcher fees were removed in May 2025; the V2 order contract does not implement that, which is Principle I twice over. Dexter 5.4.10 minswap-v2.js swapOrderFees() writes the same 2000000n into the datum. CONFIRMED AGAIN 2026-09-16 by reconciling 34 FULFILMENT transactions: 28 of 28 attributable swaps cost EXACTLY 2.000000 ADA (batcher net + network fee), matching the declared fee to the lovelace, with no proportional component; and the declared fee is 2.0 across 10 distinct pools, so unlike Splash this venue does NOT vary by pool. Caveat: BatcherFee is SUBMITTER-SETTABLE - one sampled order declared 8 ADA (it was cancelled, never charged) - so the model is right only because Dexter writes 2; this is the concrete case for M6 7.2 reading the live datum value. Method and raw evidence: docs/ops/2026-09-16-minswap-v2-batcher-fee.md and docs/ops/2026-09-16-minswap-v2-does-not-vary-by-pool.md. Pinned by dexterWritesTheBatcherFee.guard.test.ts', readAt: '2026-09-16' },
  // Stays documented on purpose. 2026-09-16 reconciled 5 live V1 fulfilments and the scooper nets
  // EXACTLY 0.000000 ADA in all five, so this method cannot measure the venue - the same result V3
  // gives, for the same reason: the fee is retained in the pool and paid through a worse price. That
  // is unverified, NOT refuted, and the shape matches V3 which we do model as a flat fee. Lowering
  // 2.5 to the 2.0 assumed default on this evidence would move a cost DOWN on no evidence at all.
  SundaeSwapV1: { batcherFeeLovelace: 2_500_000n, networkFeeLovelace: NETWORK, basis: 'documented', source: 'SundaeV3.pdf section 3 (scooper fee). NOT CONFIRMABLE by fulfilment reconciliation: 2026-09-16, 5 of 5 live V1 scoops show the scooper gaining exactly 0.000000 ADA above the network fee, so the fee never leaves as a separate output. A zero there means NOT-A-SEPARATE-OUTPUT, not FREE. See docs/ops/2026-09-16-documented-venues-measured.md', readAt: READ_AT },
  // 2026-09-09: raised 1.00 -> 1.28 on the same rule as MinswapV2 — the model follows the SUBMISSION
  // path. Dexter 5.4.10's sundaeswap-v3 adapter writes `protocolFeeDefault = 1280000n` into the
  // order, which is exactly what the M6.1 spike measured on a live quote. The old 1.00 came from the
  // documented 0.5-1.0 range and was described as an upper bound charged so results "err on the
  // expensive side" — it was neither: it sat BELOW what we would actually pay, inverting the
  // conservatism it claimed. That discrepancy is now explained rather than merely flagged.
  SundaeSwapV3: { batcherFeeLovelace: 1_280_000n, networkFeeLovelace: NETWORK, basis: 'measured', source: 'MEASURED ON CHAIN 2026-09-16: six live mainnet V3 orders across FOUR distinct pools all carry protocolFee 1280000 in top-level datum field 2; one of them totals exactly 3.28 ADA, which is this fee plus the 2 ADA returned deposit and nothing else. NOTE the fee is a PER-POOL datum value (sundaeswap-v3.js:77 reads parameters.ProtocolFee, falling back to protocolFeeDefault), so read the pool before trading it. SundaeV3.pdf 4.4.3 documents a 0.5-1.0 range that neither the library nor the chain uses. FULFILMENTS RECONCILED 2026-09-16 and this method CANNOT measure this venue: in 22 of 22 scoops the scooper gains exactly zero ADA above the network fee and the user gets the whole 3.28 back, so the 1.28 never leaves as a separate output - most likely retained in the pool as accrued revenue and paid by the user through a worse price. A zero here means NOT-A-SEPARATE-OUTPUT, not FREE. The 1.28 continues to rest on the datum evidence across 4 pools, which this does not touch. Method and raw evidence: docs/ops/2026-09-16-sundaeswap-v3-protocol-fee.md and docs/ops/2026-09-16-sundaeswap-v3-fulfilments.md. Pinned by dexterWritesTheBatcherFee.guard.test.ts', readAt: '2026-09-16' },
  // 2026-09-16: DOWNGRADED from documented 0.95 to assumed 2 ADA, and the value goes UP. The flat
  // figure is not merely unverified, it is refuted in SHAPE: seven live fulfilments span 0.0049 to
  // 3.4657 ADA per order and in one the matchmaker LOST money. MuesliSwap is an order book rather
  // than an AMM, so matchmaker economics vary per order and no single number describes them. That is
  // what `assumed` means here - no usable figure, charged the 2 ADA default and named in every report
  // it touches. 2 ADA sits above the measured median of 1.16 and below the 3.47 maximum.
  MuesliSwap: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'REFUTED AS A FLAT FEE 2026-09-16: 7 live fulfilments took 0.0049, 0.2588, 0.2588, 1.1640, 1.5000, 1.5000 and 3.4657 ADA per order. Two land on exactly 1.5 which looks like a real tier; the rest do not, and one matchmaker net was MINUS 1.02 ADA. docs.muesliswap.com states 0.95, which none of the seven paid. Charged the assumed default instead of a number nobody measured. See docs/ops/2026-09-16-documented-venues-measured.md', readAt: '2026-09-16' },
  WingRiders: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'Docs state no amount. CORROBORATED 2026-09-16 (total only, NOT the split): 17 of 21 live token-input orders at addr1wxr2a8h... attach exactly 4.00 ADA, which is what Dexter models as agentFee 2 + oil 2 (returned). A 4.00 total is equally consistent with a 1.5 fee and a 2.5 deposit, so this stays ASSUMED — the venue total is corroborated, the split is not. See docs/ops/2026-09-16-remaining-four-venues.md', readAt: '2026-09-16' },
  WingRidersV2: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'Docs state no amount. CORROBORATED 2026-09-16 (total only, NOT the split): 31 of 38 live token-input orders at addr1w8qnfkpe... attach exactly 4.00 ADA, matching Dexter agentFee 2 + oil 2 (returned). Stays ASSUMED for the same reason as WingRiders V1. See docs/ops/2026-09-16-remaining-four-venues.md', readAt: '2026-09-16' },
  VyFinance: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'Docs state no amount. NOT MEASURED 2026-09-16: VyFinance orders go to a PER-POOL marketOrderAddress, so there is no single credential to sample, and its order datum carries no fee field. Note also that Dexter models 1.90 ADA here (processFee 1900000n), 0.10 BELOW this entry — conservative, but the two disagree and neither is measured. See docs/ops/2026-09-16-remaining-four-venues.md', readAt: '2026-09-16' },
  Splash: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'Docs state no amount. MEASURED 2026-09-16 AND POSSIBLY UNDERSTATED HERE: 25 of 25 live order datums carry TWO fee fields, BaseFee 1000000 (field 4) and ExecutionFee 2000000 (field 8) = 3.00 ADA total, against the 2.00 modelled here. Whether BaseFee is additive, a floor, or refunded needs a fulfilment-transaction read; until then this is left at 2.00 because changing it is re-parameterising the cost model (founder decision). FULFILMENTS READ 2026-09-16 and the answer is worse than 3: across 10 token-to-ADA orders the executor took 2 ADA PLUS ~1.00% of proceeds on 7 of them (0.995-1.006%, over a 3x size range), and exactly 2 ADA on the other 3. WORSE, CONFIRMED 2026-09-16 by reading the anomalies: the split is BY POOL - seven orders on one pool paid 2 ADA + 1.00%, three on another paid a flat 2 ADA, same fee collector, identical order datums. VENUE_COSTS is keyed by VENUE, so this cannot be represented even with a proportional field added; the KEY is wrong for this venue, not just the shape. 1% per leg is ~200 bps per round trip against a measured SNEK floor of 371. Left at 2.00 because the fix is a schema change (founder decision). NOT URGENT: Splash has 0 snapshots in 7 days and 0 fills ever, so nothing traded so far is affected. See docs/ops/2026-09-16-splash-fulfilment-read.md and docs/ops/2026-09-16-remaining-four-venues.md', readAt: '2026-09-16' },
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
 * Distinct venues with assumed costs among FILLED orders, sorted; the report names them. A `DexName`
 * venue is assumed when its `VENUE_COSTS` entry says so — `documented` and `measured` venues are both
 * left out, because the warning means "this fee may not be what you pay" and for those two it is not
 * a guess. Note the grade is read from the LIVE table, not from the run's persisted `params.costs`,
 * so re-running `report` on an old run reflects what is known NOW rather than what was known then. Any OTHER venue —
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
