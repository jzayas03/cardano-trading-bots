# Phase 1 Data Model: Cost Floor Distribution

**Date**: 2026-09-16 | **Plan**: [plan.md](./plan.md)

No database schema changes. Every entity below is an in-memory type in the pure layer. Field names
of existing columns are quoted from the migrations, not invented.

## Existing tables read (no writes, no migration)

**`pool_snapshots`** — the observation source. Fields used:
`dex`, `pool_id`, `tick_ts`, `base_unit`, `quote_unit` (always `'lovelace'`), `reserve_base`,
`reserve_quote`, `fee_bps`, `tvl_lovelace`, `pool_type` (always `'cpmm'`), `is_primary`.
PK `(pool_id, tick_ts)`.

**`paper_orders`** — the corroboration sample only. Fields used:
`run_id`, `seq`, `ts_fill`, `pool_id`, `side`, `unit_in`, `amount_in`, `unit_out`, `amount_out`,
`mid_price`, `fill_price`, `pool_fee_in`, `batcher_fee_lovelace`, `network_fee_lovelace`,
`slippage_bps`, `price_impact_bps`, `status`.

**`VENUE_COSTS`** (`packages/sim-executor/src/costs.ts`, not a table) — `batcherFeeLovelace`,
`networkFeeLovelace`, `basis`, `source`, `readAt`, keyed by venue.

## Entities

### Route

What a trade would execute against. **Keyed by pool, not by venue** — Splash proved a venue-keyed
cost model cannot express a per-pool fee, and the same shape would hide per-pool depth differences
on MinswapV2's 20 pools.

| field | type | notes |
|---|---|---|
| `poolId` | string | `dex:identifier`, e.g. `MinswapV2:f580` |
| `venue` | string | derived via `venueOf(poolId)`, never stored separately |
| `baseUnit` | string | the non-ADA side |
| `feeBps` | number | the pool's own fee, from the snapshot, not from a table |

### SizeBucket

Fixed before the first run so the buckets cannot be chosen to flatter a result. Defined in
**lovelace notional** — never `amount_in`, which is lovelace on a buy and base subunits on a sell.

| bucket | notional | why this size |
|---|---|---|
| `100` | 100 ADA | `MIN_BUY_LOVELACE` — the smallest order a strategy will place |
| `250` | 250 ADA | between the two live sizes |
| `500` | 500 ADA | `scheduledAccumulation.defaultParams.buyAda` |
| `1000` | 1,000 ADA | ~ the 990 ADA of run 139, the observation 216 bps came from |
| `2500` | 2,500 ADA | the size at which impact should dominate the fixed fee |

### CostObservation

One modelled round trip on one route at one size at one tick. **The unit of the distribution.**

| field | type | notes |
|---|---|---|
| `poolId`, `sizeBucket`, `tickTs` | — | identity |
| `roundTripBps` | number | the figure. See the arithmetic below. |
| `impactBps` | number | curve component only, fee-inclusive |
| `fixedFeeBps` | number | (batcher + network) × 2 over notional |
| `tvlLovelace` | bigint | carried so a thin-pool figure is recognisable as one |
| `source` | `'quote' \| 'fill'` | never mixed inside a cell |

**The arithmetic, stated once so it can be checked.** CORRECTED 2026-09-16 during implementation;
the original version of this section is wrong and the reason is worth keeping. For a round trip of
notional `N` lovelace on a pool with reserves `(rQuote, rBase)` and fee `feeBps`:

1. `idealBase = N * rBase / rQuote` — what `N` buys **at mid**: no fee, no impact.
2. `outBase = cpmmAmountOut(N, rQuote, rBase, feeBps)` — the pool fee is **inside** this.
3. `oneWayBps = (idealBase - outBase) / idealBase` in bps. Pool fee **and** own impact, fee-inclusive.
4. `impactBps = 2 * oneWayBps` — a round trip is two one-way legs.
5. `fixedFeeBps = 2 * (batcherFeeLovelace + networkFeeLovelace) / N` in bps.
6. `roundTripBps = impactBps + fixedFeeBps`.

**Why one way doubled, and not a there-and-back through the pool.** The original arithmetic priced
a buy and then sold the base straight back through the post-buy reserves. That is wrong, and
measurably so: an immediate round trip returns you to the same point on the constant-product curve,
so **own price impact cancels exactly**. Measured at `feeBps = 0`, a 50,000 ADA there-and-back into a
100,000 ADA pool costs **0.000000 bps**. With a fee it gets *cheaper* as size grows — 59.85 bps at
100 ADA falling to 40.02 at 50,000 — because the favourable price displacement from the buy offsets
the sell's fee.

That is a true property of a self-reversing trade and a useless model of trading. A strategy buys at
`t` and sells at `t+k` against reserves that have moved, so the two impacts do not cancel. Doubling
the one-way cost is also exactly the structure `docs/specs/2026-09-08-m6-execution.md` §2.1 uses to
reach 216 from 108.

The monotonicity test (C1.5) is what caught it: impact was *decreasing* with order size, which
cannot be right. That test exists for this.

**Assumption worth naming**: the sell leg is modelled as symmetric to the buy leg, at the same
notional against the same reserves. The real sell happens at a different time and size. This is the
same assumption §2.1 makes by doubling, and it is part of why the output is **modelled**, not
realised.

**What is NOT in this sum, and must never be added to it**: `slippageBps` and `priceImpactBps` as
computed at fill time. Both already contain the pool fee, and so does `curveLossBps`. Adding any of
them together charges the pool fee two or three times — the exact defect
`docs/specs/2026-09-08-m6-execution.md` §2.1 names. Step 3 replaces them; it does not combine them.

### CostDistribution

The summary for one (route, size bucket).

| field | type | notes |
|---|---|---|
| `route`, `sizeBucket` | — | identity |
| `verdict` | `'sufficient' \| 'insufficient'` | `n >= MIN_OBSERVATIONS` (30) |
| `n` | number | always present, even when insufficient |
| `firstTs`, `lastTs` | timestamp | always present |
| `p50`, `p75`, `p90` | number \| **null** | **null when insufficient** — not a small-sample estimate |
| `floorBps` | number \| null | `= p90` (D2). Null when insufficient. |
| `basis` | `'measured' \| 'documented' \| 'assumed'` | the weakest component |
| `medianTvlLovelace` | bigint | depth context |

**Invariant**: `verdict === 'insufficient'` implies `p50 === null && p75 === null && p90 === null &&
floorBps === null`. An insufficient bucket must be structurally incapable of rendering a percentile
(FR-003), rather than relying on the formatter to hide it.

### ExclusionRecord

Why a venue produced no distribution. Required by FR-017 so the cost of D1 stays visible.

| field | type | notes |
|---|---|---|
| `venue` | string | |
| `reason` | `'unmeasured-fee' \| 'varies-by-pool' \| 'no-snapshots' \| 'not-a-market'` | |
| `detail` | string | e.g. "basis=assumed; per-pool marketOrderAddress never measured" |
| `snapshotsAvailable` | number | what was given up |

Expected at first run: `WingRiders`, `WingRidersV2`, `VyFinance` → `unmeasured-fee`; `Splash` →
`varies-by-pool`; `synthetic` and `Fake` → `not-a-market`.

### FloorLookup (FR-009)

The consumable surface. **Fails closed**: returns an explicit insufficiency, never a global default.

```
lookupFloor(poolId, notionalLovelace)
  -> { kind: 'floor', bps, basis, n, asOf }
   | { kind: 'insufficient', n, required }
   | { kind: 'excluded', venue, reason }
```

There is deliberately no fourth case that returns a number when data is missing. M6 §7 requires fail
closed, and a silent fallback to 216 is exactly the behaviour this feature exists to remove.

## Provenance record

Written into every report run so a figure is re-derivable (FR-012, SC-004):
the report's own run timestamp; the `VENUE_COSTS` amounts, `basis`, `source` and `readAt` used; the
snapshot date range; `MIN_OBSERVATIONS`; the size buckets; and the git sha.
