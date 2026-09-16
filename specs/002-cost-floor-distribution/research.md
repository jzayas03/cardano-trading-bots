# Phase 0 Research: Cost Floor Distribution

**Date**: 2026-09-16 | **Spec**: [spec.md](./spec.md)

Everything below was verified against the code, the migrations, or the live database. Where a
belief carried into this feature turned out to be wrong, the correction is recorded rather than
quietly applied.

## R1. The source of observations is pool snapshots, not fills

**Decision**: compute observations from `pool_snapshots` (reserves + `fee_bps` at a tick), priced
through the CPMM curve at a set of order sizes. Use `paper_orders` fills only as a corroboration
sample, never as the primary distribution.

**Rationale**: measured on the live database on 2026-09-16.

| source | rows available on measured venues |
|---|---|
| `paper_orders` filled, real venues | **42 ever** — MinswapV2 25 buy + 16 sell, SundaeSwapV3 1 buy |
| `pool_snapshots`, measured venues | **19,948** — MinswapV2 19,756 over 20 pools and 2,407 ticks; SundaeSwapV3 192 over 9 pools and 30 ticks |

Of the 3,560 filled `paper_orders` rows, **3,514 are the `synthetic` venue** (backtests against
generated data) and 3 are `Fake` (the rehearsal venue). Both are excluded: neither is a market.

The fills path cannot work. A round trip needs a buy and a sell, MinswapV2 has 16 sells and
SundaeSwapV3 has none, so **at most 16 round trips exist on measured venues in the project's
history** — before splitting by pool and by order size. Against a sufficiency threshold of 30 per
bucket, not one bucket could ever qualify. The spec anticipated "no bucket reaches n=30" as a
legitimate outcome; from fills it is not a risk but a certainty.

This is also what the M6 spec actually asked for. §2.1 says the floor "should become a measured
DISTRIBUTION per route and order size, taken from **contemporaneous quotes**" — quotes, not fills.
A snapshot's reserves are a contemporaneous quote.

**Alternatives considered**: (a) fills only — rejected, n≤16 forever; (b) fetching fresh quotes from
a DEX aggregator — rejected, adds a network dependency and a new quota for data we already hold;
(c) Koios chain reads of other traders' fulfilments — rejected for the primary path because it
measures *their* order sizes, not ours, though it remains the right tool for venue fee measurement.

## R2. Modelled, not realised — and the report must say so

**Decision**: label every figure as modelled execution cost. Do not describe the output as measured
realised cost under any circumstance.

**Rationale**: a quote priced through the curve captures pool fee, own price impact and the fixed
venue fees. It captures **none** of: batcher queue latency, the price moving between submission and
execution, partial fills, expiry, or adverse selection against a visible order. M6 §5 lists exactly
these as "what paper does not model, and live must", and §7.3 states that the rate at which order
visibility is exploited "becomes measurable at M6.5, the first funded trade" and not before.

Widening the sample from 1 to ~20,000 improves the estimate of a modelled quantity. It does not
convert paper into live. Spec FR-007 requires this be recorded alongside the distribution.

## R3. Stored fees are historical; the basis grade is not

**Decision**: the quote path uses today's `VENUE_COSTS`, and every report run records the venue
amounts and `basis`/`readAt` it used. The corroboration path uses each fill's **stored** fee columns.
The report states which source each figure came from.

**Rationale**: verified in the schema and code. `paper_orders.batcher_fee_lovelace` and
`network_fee_lovelace` are real columns written from the `VenueCosts` resolved at fill time
(`simExecutor.ts:135` → `repo.ts:271`), so historical fills carry the fee that was modelled then.
But the **provenance** has no column: `assumedVenuesTouched` re-reads `VENUE_COSTS[v].basis` from the
live module, and `costs.ts:92-93` says so explicitly — "the grade is read from the LIVE table … so
re-running `report` on an old run reflects what is known NOW rather than what was known then".

This is not hypothetical today. SundaeSwapV3's modelled batcher fee changed from 1,000,000 to
1,280,000 on 2026-09-16 when it was measured on chain. Fills written before that carry 1,000,000 in
the column while the live table says 1,280,000. On a 1,000 ADA leg those differ by ~28 bps. Neither
is wrong; they answer different questions, and a report that silently mixes them is wrong.

`runs.params.costs.venues` snapshots the whole table per run, so the run-time grade is recoverable
where that is the question.

**Alternatives considered**: recomputing historical fills with today's fees — rejected, it
retroactively rewrites what a run paid; adding a basis column to `paper_orders` — rejected as out of
scope, it is a migration in service of a report.

## R4. There are two different `priceImpactBps`, with opposite fee treatment

**Decision**: the quote path computes cost with the pool fee **included** (`cpmmAmountOut` with the
pool's real `feeBps`), matching the fill-metric definition. The report names which definition it
used. The existing 34 bps depth threshold is **not changed** — the discrepancy below is documented,
not fixed, because fixing it is a cost-model change and therefore a founder decision.

**Rationale**: verified from the arithmetic, not from comments.

- `simExecutor.priceImpactBps` (`simExecutor.ts:137`) prices the fill with `cpmmAmountOut(..., pool.feeBps)` — the pool fee is inside the fill price, and neither reference mid contains it. So it **includes** the pool fee.
- `depth.priceImpactBps` (`depth.ts:47`) calls `cpmmAmountOut(..., 0)` — fee forced to zero. It **excludes** the pool fee.

Same name, opposite meaning. And `DEFAULT_MAX_IMPACT_BPS = 34` is justified at `depth.ts:66-67` as
the impact half of the *fee-inclusive* run-139 measurement, while being compared against the
*fee-exclusive* computation. **The 34's stated basis is the wrong quantity for the place it is
used.** Making the floor's basis explicit means saying that out loud.

Mitigating, and the reason this is documentation rather than a defect to fix here:
`DEFAULT_MAX_IMPACT_BPS` has **zero production consumers** — a repo-wide grep for `filterByDepth`,
`liquidEnough` and `DEFAULT_MAX_IMPACT` finds call sites only in `depth.test.ts`. It is a
documented, tested, unwired constant. Nothing at runtime depends on the mismatch.

## R5. The promotion gate does not check cost at all

**Decision**: FR-009's floor lookup ships as a library function with no gate wired to it, and the
plan says so rather than implying an integration that does not exist.

**Rationale**: `promotion.ts` has exactly five checks — `round-trips`, `coverage`, `comparable`,
`measurable`, `beats-baselines`. `PromotionInput` has no cost, fee or floor field. The only mention
of the floor in the file is rhetorical, justifying n=30. `DEFAULT_FLOOR_BPS` has **one** production
consumer in the whole repo: the `opportunity` command.

So "a strategy has cleared the cost floor" (M6 §2 gate 1) is a **human gate applied by reading a
report**, not a coded one. Costs are netted inside `returnBasePct`, and the gate compares against
baselines that pay the same costs, which is a different and defensible mechanism — but it is not a
floor check. This feature supplies the number that human gate needs; wiring it into an automated
control is M6.3 work and changing the gate is a founder decision either way.

## R6. Venue is derivable; order size is not a single unit

**Decision**: derive venue from `pool_id` via the existing `venueOf()`; bucket order size by
**lovelace notional**, taking `amount_in` on a buy and `amount_out` on a sell.

**Rationale**: `paper_orders` has no venue column, but `pool_id` is `dex || ':' || identifier`
(`0001_core.sql:35`) and `venueOf()` already splits on `:` (`costs.ts:70`). `pool_snapshots` does
carry `dex` directly.

Order size is the trap: `amount_in` is **lovelace on a buy but base-token subunits on a sell**
(`simExecutor.ts:131`), so bucketing on `amount_in` alone silently mixes two units — precisely the
failure Constitution Principle II is about, and one that has already cost this project three months
of mis-denominated candles.

## R7. The double-counting defect is live in two published documents

**Finding, not a decision.** FR-006 requires an automated check that the two overlapping bps measures
are never summed. Verified: **no code anywhere sums them** — every site presents them as separate
columns, and `repo.pg.test.ts:36-46` already pins "price impact is stored in its own column, not
folded into slippage".

But the defect is live in prose, in two documents that look authoritative:

- `docs/ops/2026-09-09-strategy-state.md:40` — "Floor = 2 x (pool fee + impact(depth) + 22 bps spread + 22 bps batcher)", which charges the pool fee once explicitly and again inside `impact(depth)`, and invents a spread term.
- `docs/ops/2026-09-09-token-choice-ada.md:14-23` — the same formula, and its header ("the floor is not 216 bps for everybody") reads as a correction rather than an error.

Both drive a published per-token floor table (ASCEND 477, STRIKE 411, SNEK 371, WMTX 561 bps). None
of it is implemented in code. The guard this feature adds must therefore cover **documents**, not
only source, or it will pass while the defect stays in the files a human actually reads.

## R8. Where each piece lives

**Decision**: pure computation in `@ctb/reports`; database reads and the CLI entry in `@ctb/cli`;
reuse `@ctb/sim-executor` for the curve and the cost table.

**Rationale**: the purity guard is a raw source-text regex over `packages/reports/src`, forbidding
`from '<spec>'` for `pg`, `@ctb/db`, `@ctb/cli`, `@ctb/collector`, `@ctb/candles`,
`node:child_process`, `node:fs`, `node:net`, `node:http`. **`@ctb/sim-executor` is not on that list**,
and `cpmmAmountOut`, `VENUE_COSTS`, `venueOf` and `costsForPoolId` all live there — so the pure layer
may price a quote without breaking the guard.

Reuse rather than reinvent: `quantile(values, q)` is already exported from
`packages/reports/src/opportunity.ts:118`. The repo already carries three quantile implementations;
a fourth would be the wrong answer. `adaStr` and the decimal helpers in `format.ts`/`decimal.ts`
exist for exact bigint arithmetic — `Number(x)/1e6` is banned there for a documented reason.

The `opportunity` command is the closest structural template: raw SQL in the CLI, grouping in the
CLI, a pure function taking `readonly T[]`, and a `render*` returning `string[]` so the numbers stay
testable apart from the formatting.

## R9. What the first run is expected to conclude

**Prediction, recorded before implementation so it cannot be rationalised afterwards.**

- **MinswapV2 will have ample observations.** 19,756 snapshots over 20 pools and 2,407 ticks. Most (pool, size-bucket) cells should clear n=30 comfortably, and the per-pool spread will be visible for the first time.
- **SundaeSwapV3 will be marginal.** 192 snapshots over 9 pools and 30 ticks is ~21 per pool. Most cells will report **insufficient**, and that is the correct output.
- **Four venues will be excluded entirely** under D1 — WingRiders, WingRidersV2, VyFinance, Splash — and FR-017 requires each exclusion be listed with its reason.
- **The p90 will very likely exceed 216 bps on the thinner pools and at larger sizes**, because 216 came from one fill of 990 ADA on one pool on one day, and price impact grows with size while the fixed 2.2 ADA shrinks as a proportion. Expect the headline to be *worse* than 216 for big orders and *better* for small ones on deep pools — which is the whole point of a per-route, per-size distribution.
- **The corroboration sample will be tiny**: 41 MinswapV2 fills, 1 SundaeSwapV3 buy. Enough to check the quote model reproduces observed slippage in the right ballpark. Not enough to validate it.

If the implementation produces a single global number, or reports n≥30 for SundaeSwapV3 pools, or
shows no per-pool spread on MinswapV2, something is wrong with it rather than surprising about the
market.
