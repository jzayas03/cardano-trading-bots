# Implementation Plan: Cost Floor Distribution

**Branch**: `feat/cost-floor-plan` | **Date**: 2026-09-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-cost-floor-distribution/spec.md`

## Summary

Replace a cost floor known from **one** observation with a distribution computed from **~20,000**.

The source is `pool_snapshots`, not fills. That is the plan's load-bearing decision and it was forced
by measurement: only 42 fills exist on measured venues in the project's entire history, and at most
16 of them can form a round trip, so a fills-based distribution could never reach the n=30
sufficiency bar. Snapshots carry reserves and `fee_bps` at a tick, which is exactly the
"contemporaneous quote" M6 §2.1 asked for, and there are 19,948 of them on measured venues.

A new `ctb cost-floor` command reads snapshots, prices a hypothetical round trip through the CPMM
curve at a set of order sizes, and reports a per-route, per-size distribution with p50/p75/p90,
observation counts and date ranges — or an explicit **insufficient** verdict where the data does not
support a figure. Venues whose cost cannot be measured are excluded and listed with the reason (D1).
The headline figure is p90 (D2).

Nothing in the cost model, the promotion gate, or the constitution's stated 216 bps changes. The
deliverable is evidence and a recommendation.

## Technical Context

**Language/Version**: TypeScript, Node (see `.nvmrc`), ESM

**Primary Dependencies**: existing workspace only — `@ctb/reports` (pure computation),
`@ctb/sim-executor` (`cpmmAmountOut`, `VENUE_COSTS`, `venueOf`), `@ctb/cli` (entry + SQL), `pg`.
**No new dependency.**

**Storage**: Postgres. Reads only: `pool_snapshots`, and `paper_orders` for the corroboration
sample. **No migration, no write.**

**Testing**: vitest. Pure functions unit-tested in `packages/reports/test/`; SQL pinned in a
`.pg.test.ts` under `packages/cli/test/`; the gate is `npm run test:pg` (`RUN_PG_TESTS=1`), plus
`npm run lint` and `npm run lint:sh`. `npm test` and `npx vitest` are not evidence.

**Target Platform**: developer machine and the VPS; a read-only report, run on demand.

**Project Type**: CLI report over an existing monorepo.

**Performance Goals**: a full run over ~20k snapshots × 5 size buckets is ~100k curve evaluations of
bigint arithmetic. Target: under 30 s on the 2 GB VPS, and it must not hold a transaction open while
computing.

**Constraints**: no funds, no keys, no preprod, no mainnet, nothing that moves value. No change to
any fee value, any promotion threshold, or the stated floor. `@ctb/reports` stays pure. Exact
bigint/decimal arithmetic — `Number(x)/1e6` is banned in the pure layer.

**Scale/Scope**: 2 measured venues, ~29 pools, ~2,437 distinct ticks, 5 order-size buckets.

## Constitution Check

| Principle | Assessment |
|---|---|
| **I. The cost model is measured, never asserted** | This is the principle's own programme. The feature measures and never asserts, and changes no fee value. The one place it could violate the principle is by *recommending* a lower floor; that is routed to a stop-and-ask task, never an edit. **PASS** |
| **II. Units are part of the number** | The live trap: `paper_orders.amount_in` is lovelace on a buy and base subunits on a sell. Size buckets are defined in **lovelace notional** and the derivation is explicit per side (R6). Every reported figure carries bps or ADA. **PASS** |
| **III. A quoted price is not a market** | Directly relevant: snapshots include thin pools whose quotes are fiction. The report is per-pool, so a thin pool shows as its own bad distribution rather than polluting an average, and depth is reported alongside. **PASS, with the depth caveat carried into the output.** |
| **IV. `npm test` is not the gate** | `test:pg` + `lint` + `lint:sh`, and a real run against real data (quickstart). **PASS** |
| **V. The promotion gate exists in order not to be gamed** | The feature touches no threshold. It is likeliest to make strategies look *worse*, and the spec pre-commits to that being the finding rather than an argument for changing the percentile. **PASS** |

**No violations. No entries in Complexity Tracking.**

One constitutional note rather than a violation: Principle I states the floor as "216 bps, and it is
measured." This feature does not contradict that — it makes it checkable, and replaces n=1 with a
distribution. If the result warrants amending the constitution's wording, that is a founder decision
and a separate PR.

## Project Structure

### Documentation (this feature)

```
specs/002-cost-floor-distribution/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── cost-floor.md    # Phase 1: the pure surface and the CLI contract
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```
packages/reports/src/
├── costFloor.ts          # NEW. Pure: observations -> per-route/per-size distributions.
└── index.ts              # edit: export the new surface

packages/reports/test/
├── costFloor.test.ts     # NEW. Pure unit tests, incl. the insufficiency and unit properties.
└── noSummedBpsMeasures.guard.test.ts   # NEW. FR-006 control; scans src AND docs.

packages/cli/src/
├── commands/costFloor.ts # NEW. SQL, size bucketing, render* -> string[].
└── main.ts               # edit: import, case, usage line

packages/cli/test/
├── costFloorRender.test.ts    # NEW. Rendering properties (no bare figure without n).
└── costFloorSql.pg.test.ts    # NEW. Pins the SQL semantics. RUN_PG_TESTS=1.

package.json              # edit: "cost-floor" script
```

**Structure Decision**: the existing monorepo, following the `opportunity` command's shape exactly —
SQL and grouping in the CLI, a pure function over `readonly T[]` in `@ctb/reports`, and a `render*`
returning `string[]` so the numbers stay testable apart from formatting. The pure layer may import
`@ctb/sim-executor` because the purity guard does not forbid it (R8), which is what lets the curve
maths stay pure.

## Phase boundaries and what is deliberately NOT built

- **No migration.** No column is added to `paper_orders`, including the basis column R3 shows is missing. A schema change in service of a report is the wrong trade.
- **No gate wiring.** FR-009's lookup ships as a library function with no consumer, because the promotion gate does not check cost at all (R5). Wiring it is M6.3.
- **No change to `DEFAULT_MAX_IMPACT_BPS`.** R4 found its stated basis is the wrong quantity for where it is used. It has zero production consumers, so the mismatch is documented in the output and left alone; correcting it is a cost-model change.
- **No correction of the two published documents** carrying the double-counted formula (R7). The guard will *fail* on them, which is the point; fixing their numbers is a separate PR because it changes published per-token floors.
- **No fresh quotes from any network source.** Everything comes from data already collected.

## Risks

| Risk | Handling |
|---|---|
| The quote model silently diverges from how fills were actually priced | Corroboration sample: replay the 41 MinswapV2 fills through the same code path and compare against their stored `slippage_bps`. Small, but a systematic sign error would show. |
| Thin pools dominate the distribution | Report per pool, never a venue-level average that mixes depths; carry TVL alongside each cell. |
| Size buckets chosen to flatter the result | Buckets fixed in the contract before the first run, spanning the sizes the strategies actually use (`MIN_BUY_LOVELACE` = 100 ADA, `scheduledAccumulation.buyAda` = 500). |
| The report is run, dislikes its answer, and the percentile is quietly revisited | D2 pre-commits in the spec; R9 records the expected conclusion before implementation so it cannot be rationalised after. |
| Today's `VENUE_COSTS` differ from what historical fills paid | Every run records the amounts and `basis`/`readAt` it used, and quote figures are never mixed with fill figures in one cell (R3). |
