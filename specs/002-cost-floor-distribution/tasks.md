---
description: "Task list for Cost Floor Distribution"
---

# Tasks: Cost Floor Distribution

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Contract**: [contracts/cost-floor.md](./contracts/cost-floor.md)

**Input**: plan.md, research.md, data-model.md, contracts/cost-floor.md, quickstart.md — all merged.

## Format: `[ID] [P?] [Story] Description`

- **[P]** = parallelisable (different file, no dependency on an incomplete task)
- **[US1] / [US2] / [US3]** = the user story from spec.md this serves

## Standing constraints — these apply to EVERY task below

1. **TDD.** The test comes first and must fail for the right reason before the implementation exists.
2. **`@ctb/reports` stays pure.** The guard is a raw source-text regex over `packages/reports/src`
   forbidding `from '<spec>'` for `pg`, `@ctb/db`, `@ctb/cli`, `@ctb/collector`, `@ctb/candles`,
   `node:child_process`, `node:fs`, `node:net`, `node:http`. **`@ctb/sim-executor` is NOT forbidden** —
   the pure layer may import `cpmmAmountOut`, `VENUE_COSTS`, `venueOf`. Every `@ctb/engine` import
   must be `import type`; the guard does not enforce that, so it is on you.
3. **Reuse, do not reinvent.** `quantile` is already exported from
   `packages/reports/src/opportunity.ts:118`. The repo already carries three quantile
   implementations — **a fourth is a defect, not a convenience**. `adaStr` and the decimal helpers
   exist because `Number(x)/1e6` is banned in the pure layer.
4. **Nothing is "implemented" until `npm run test:pg` AND `npm run lint` AND `npm run lint:sh` are
   green.** `npm test` and `npx vitest` skip every Postgres test and are not evidence.
5. **Do not change** `VENUE_COSTS` values, `MIN_ROUND_TRIPS`, `DEFAULT_FLOOR_BPS`,
   `DEFAULT_MAX_IMPACT_BPS`, `promotion.ts`, or the constitution. Any recommendation to change the
   cost model or the stated 216 bps is **T034, a stop-and-ask** — never an edit.
6. **No migration, no write, no network, no funds, no keys.** Reads only.

## Path Conventions

Monorepo at the repository root. Pure computation in `packages/reports/`, SQL and CLI in
`packages/cli/`, curve and cost table reused from `packages/sim-executor/`.

---

## Phase 1: Setup

- [ ] T001 Add a `"cost-floor": "tsx packages/cli/src/main.ts cost-floor"` script to `package.json`, matching the existing `opportunity` and `lp` entries.
- [ ] T002 [P] Create the empty module `packages/reports/src/costFloor.ts` exporting nothing yet, and add `export * from './costFloor.js';` to `packages/reports/src/index.ts`, so the purity guard starts scanning it from the first commit rather than after the code lands.

---

## Phase 2: Foundational (blocking prerequisites)

**Blocking**: every user story depends on the size buckets and the observation type existing.

- [ ] T003 Define `SIZE_BUCKETS` in `packages/reports/src/costFloor.ts` as lovelace notional constants for 100, 250, 500, 1,000 and 2,500 ADA, with a comment tying each to its source: 100 = `MIN_BUY_LOVELACE` (`packages/engine/src/strategies/params.ts:24`), 500 = `scheduledAccumulation.defaultParams.buyAda`, 1,000 ≈ the 990 ADA of run 139 that 216 bps came from. **Buckets are fixed here, before any run, so they cannot later be chosen to flatter a result.**
- [ ] T004 [P] Define the types `Route`, `CostObservation`, `CostDistribution`, `ExclusionRecord` and `FloorAnswer` in `packages/reports/src/costFloor.ts`, verbatim per [data-model.md](./data-model.md). `CostDistribution.p50 | p75 | p90 | floorBps` MUST be typed `number | null` — the null case is part of the type, not a runtime convention.
- [ ] T005 [P] Write `packages/reports/test/costFloorUnits.test.ts` asserting that a size bucket is interpreted as **lovelace notional** and never as `amount_in`: a buy's `amount_in` is lovelace but a sell's is base subunits (`simExecutor.ts:131`), so a helper that derives notional per side must return lovelace for both. Must fail before T006.
- [ ] T006 Implement the notional helper in `packages/reports/src/costFloor.ts` so T005 passes. Take `amount_in` on a buy and `amount_out` on a sell.

---

## Phase 3: User Story 1 — The founder sees a spread, not a headline (P1) 🎯 MVP

**Goal**: a per-route, per-size distribution with p50/p75/p90, counts and date ranges, or an explicit insufficiency.

**Independent test**: run the report against real snapshots and read it. Delivers the decision value even if US2 and US3 never ship.

### Tests for User Story 1 ⚠️ write these first

- [ ] T007 [P] [US1] Write `packages/reports/test/costFloor.test.ts` covering `costObservations`: one observation per (snapshot, bucket) (C1.1); a snapshot with zero or negative reserves yields **no** observation rather than an `Infinity` one (C1.1); `roundTripBps === curveLossBps + fixedFeeBps` and nothing else (C1.2); fixed fees counted **twice**, once per leg, over the lovelace notional (C1.3). Must fail before T010.
- [ ] T008 [P] [US1] Extend `costFloor.test.ts` with the arithmetic control: build a pool with known reserves, price a round trip by hand per [data-model.md](./data-model.md) steps 1-5, and assert the implementation matches to the bps. **Assert separately that `roundTripBps` is NOT equal to `slippageBps + priceImpactBps` for the same scenario** — the two fill-time measures each already contain the pool fee, and this is the arithmetic form of FR-006.
- [ ] T009 [P] [US1] Extend `costFloor.test.ts` with the **structural** insufficiency invariant (C2.2): a bucket with `n = 29` returns `verdict: 'insufficient'` **and `p50 === null && p75 === null && p90 === null && floorBps === null`**, asserted directly on the returned object. **Never assert this through a rendered string** — the invariant is in the data, not the formatter. Also assert C2.3: `n`, `firstTs`, `lastTs` present on every distribution including insufficient ones; and C2.4: `floorBps === p90` exactly when sufficient.

### Implementation for User Story 1

- [ ] T010 [US1] Implement `costObservations(snapshots, opts)` in `packages/reports/src/costFloor.ts` so T007 and T008 pass. Price the round trip through `cpmmAmountOut` twice, the second leg against reserves updated by the first. `bigint` throughout; no `Number` division on lovelace before the final bps conversion (C1.6).
- [ ] T011 [US1] Implement `costDistributions(observations, opts)` so T009 passes. Group by `(poolId, sizeBucket)`. **Never compute a venue-level aggregate** (C2.1) — a single global floor must be impossible to print by accident, because it is never computed. Use the exported `quantile` from `opportunity.ts`; do not add a fourth implementation. Default `MIN_OBSERVATIONS = 30`.
- [ ] T012 [US1] Add `packages/cli/src/commands/costFloor.ts` with the `SELECT` over `pool_snapshots` (fields per [data-model.md](./data-model.md)), row → `Route` mapping, and bucketing — all in the CLI, following `packages/cli/src/commands/opportunity.ts`. `SELECT` only.
- [ ] T013 [US1] Add `renderCostFloor(...)` to `packages/cli/src/commands/costFloor.ts` returning `string[]`, and wire `costFloorCommand` to `console.log` the lines. Output order per C5.2: provenance block, per-route table, insufficient list, exclusions list.
- [ ] T014 [US1] Register the command in `packages/cli/src/main.ts`: import, `case 'cost-floor':`, and a usage line in the `default:` branch.
- [ ] T015 [P] [US1] Write `packages/cli/test/costFloorRender.test.ts` asserting the rendering property **no bps figure is ever printed without its `n` beside it** (C5.3), in the style of `packages/cli/test/opportunityRender.test.ts`'s "never a bare percentage" test. Also assert an insufficient row renders without any percentile.
- [ ] T016 [US1] Write `packages/cli/test/costFloorSql.pg.test.ts` pinning the SQL semantics against a throwaway schema, following `packages/cli/test/opportunitySamples.pg.test.ts`. `describe.skipIf(!PG_ENABLED)`; requires `RUN_PG_TESTS=1`.

**Checkpoint**: US1 is complete when a `cost-floor` run against seeded data prints per-route distributions and `npm run test:pg` is green.

---

## Phase 4: User Story 2 — No figure claims to be measured when it is assumed (P1)

**Goal**: every figure carries its weakest provenance, and excluded venues are listed with reasons.

**Independent test**: run against a route whose venue basis is `assumed` and confirm it is labelled and excluded from any measured aggregate.

### Tests for User Story 2 ⚠️ write these first

- [ ] T017 [P] [US2] Extend `packages/reports/test/costFloor.test.ts`: a venue absent from `VENUE_COSTS` yields **no observation** and an `ExclusionRecord`, never a fallback to a default cost (C1.4) — matching `simExecutor`, where an unknown venue is a rejection. Must fail before T019.
- [ ] T018 [P] [US2] Extend `packages/reports/test/costFloor.test.ts`: `basis` on a distribution is the **weakest** of its components (C2.5), so a route whose venue basis is `assumed` can never report as `measured`. Assert with a fixture where the venue is `assumed` and everything else is `measured`.

### Implementation for User Story 2

- [ ] T019 [US2] Implement exclusion and basis propagation in `packages/reports/src/costFloor.ts` so T017 and T018 pass. Exclusion reasons per [data-model.md](./data-model.md): `unmeasured-fee`, `varies-by-pool`, `no-snapshots`, `not-a-market`.
- [ ] T020 [US2] Apply D1 in `packages/cli/src/commands/costFloor.ts`: exclude venues whose cost cannot be measured. Expected on today's table — `WingRiders`, `WingRidersV2`, `VyFinance` → `unmeasured-fee`; `Splash` → `varies-by-pool` (its take varies **by pool** while `VENUE_COSTS` is keyed by venue, so the key is wrong, not just the shape); `synthetic` and `Fake` → `not-a-market`.
- [ ] T021 [US2] Render the exclusions list, and assert in `packages/cli/test/costFloorRender.test.ts` that **it is emitted even when empty** (C5.2, FR-017) — the price of the exclusion policy must never be invisible.
- [ ] T022 [US2] Emit the provenance block in `renderCostFloor`: the `VENUE_COSTS` amounts, `basis`, `source` and `readAt` used; the snapshot date range; `MIN_OBSERVATIONS`; the size buckets; the git sha; and the words **modelled, not realised** (C5.4, FR-007). Note in the block that the grade is read from the LIVE table, per `costs.ts:92-93`, so it reflects what is known now.

**Checkpoint**: US2 is complete when the report labels provenance, lists every exclusion with a reason, and the gate is green.

---

## Phase 5: User Story 3 — The floor is shaped for the control that will consume it (P2)

**Goal**: a per-route, per-size lookup that fails closed.

**Independent test**: call `lookupFloor` for a route and size and receive a figure with basis and count, or an explicit refusal.

### Tests for User Story 3 ⚠️ write these first

- [ ] T023 [P] [US3] Extend `packages/reports/test/costFloor.test.ts` for `lookupFloor`: exactly three result kinds — `floor`, `insufficient`, `excluded` — and **no default-bearing fourth** (C3.1). A notional **between** buckets resolves to the **larger** bucket, the more conservative answer (C3.2). A notional **above** the largest bucket returns `insufficient`, never the top bucket extrapolated (C3.3). An **unknown** `poolId` returns `excluded`, not `insufficient` — they are different facts (C3.4). Must fail before T024.

### Implementation for User Story 3

- [ ] T024 [US3] Implement `lookupFloor(distributions, poolId, notionalLovelace)` in `packages/reports/src/costFloor.ts` so T023 passes. **There is deliberately no code path that returns a number when data is missing** — M6 §7 requires fail closed, and a silent fallback to 216 is the behaviour this feature exists to remove.
- [ ] T025 [US3] Add `--json` to `packages/cli/src/commands/costFloor.ts` emitting the same structure as data (C5.6), for the M6.3 consumer that does not exist yet. Note in the task and in the code comment that **the promotion gate does not check cost at all** (research.md R5), so this ships with no consumer by design.

**Checkpoint**: US3 is complete when `lookupFloor` has three cases, no fallback, and `--json` round-trips.

---

## Phase 6: The FR-006 control

**This phase is not polish.** It is the control for the defect the spec was written around, and it behaves differently from every other task here.

- [ ] T026 [P] Write `packages/reports/test/noSummedBpsMeasures.guard.test.ts`. Scan `packages/*/src/**/*.ts` **and** `docs/**/*.md` **and** `specs/**/*.md` (C4.1). Docs are in scope because the live instances of this defect are in published documents, not in code.
- [ ] T027 Implement the detector inside `packages/reports/test/noSummedBpsMeasures.guard.test.ts`: fail on any expression summing the two fill-time measures in either order and either casing — `slippageBps + priceImpactBps`, `slippage_bps + price_impact_bps`, and reversed (C4.2); and on a prose decomposition charging a pool fee alongside an impact term, the `pool fee + impact` shape (C4.3).
- [ ] T028 Add the **positive control** (C4.4) to `packages/reports/test/noSummedBpsMeasures.guard.test.ts`: the test contains a known-bad fixture string and asserts the detector flags it. **Without this the control is decorative** — this repo has already shipped a `shellcheck disable` bound to the wrong command that had never worked. A detector nobody proved can detect is not a control.
- [ ] T029 Add the allowlist (C4.5) with a **reason per entry**, for text that legitimately describes the defect: `contracts/cost-floor.md`, `spec.md`, `research.md`, `tasks.md` and `docs/specs/2026-09-08-m6-execution.md` §2.1. An entry names the file and why, so the list cannot quietly grow into a way of passing.
- [ ] T030 **Run the guard and record that it FAILS.** It is expected to fail against `docs/ops/2026-09-09-strategy-state.md:40` and `docs/ops/2026-09-09-token-choice-ada.md:14-23`, which carry `pool fee + impact(depth) + 22 bps spread + 22 bps batcher` — the pool fee charged twice plus an invented spread term. **That failure is the deliverable.** Capture the exact failing output into the PR description as evidence.
- [ ] T031 **DO NOT fix those two documents in this feature.** Their per-token floor table (ASCEND 477, STRIKE 411, SNEK 371, WMTX 561 bps) is a published cost-model claim, and correcting it is founder-gated under Constitution Principle I. Instead: add a two-path skip list in `packages/reports/test/noSummedBpsMeasures.guard.test.ts` naming exactly `docs/ops/2026-09-09-strategy-state.md` and `docs/ops/2026-09-09-token-choice-ada.md`, each with an inline reason referencing this task, so CI is green while the finding stays recorded; and open a follow-up issue naming both files and their line numbers. **Do not widen the skip beyond those two paths.**

---

## Phase 7: Verification against reality

- [ ] T032 Run the gate: `npm run lint`, `npm run lint:sh`, `npm run test:pg`. All three green, failures reported with their output. Nothing before this point counts as implemented.
- [ ] T033 **Real run against real data.** Execute `npm run cost-floor` against the ~19,948 measured-venue snapshots (MinswapV2 19,756 over 20 pools and 2,407 ticks; SundaeSwapV3 192 over 9 pools), and record the observed output. Check it against research.md R9's **written-in-advance** predictions: MinswapV2 mostly sufficient; SundaeSwapV3 mostly insufficient; exactly four venues excluded; no global figure anywhere; exit code 0 even if nothing is sufficient; p90 above 216 bps at 2,500 ADA on thin pools and possibly below it at 100 ADA on deep ones. **A result that contradicts R9 is investigated, not accepted** — a global number appearing, or SundaeSwapV3 reporting n≥30 on most pools, means the implementation is wrong rather than the market surprising.
- [ ] T034 **STOP AND ASK.** If T033's distribution suggests the cost model or the constitution's stated 216 bps should change, write the recommendation with its evidence and **stop**. Lowering or re-parameterising the cost model is a founder decision under Constitution Principle I and the stop-and-ask list. Do not edit `costs.ts`, `promotion.ts`, `depth.ts` or `constitution.md`.
- [ ] T035 Corroboration replay, as `packages/cli/test/costFloorCorroboration.pg.test.ts` (`describe.skipIf(!PG_ENABLED)`, requires `RUN_PG_TESTS=1`). Price the 41 filled MinswapV2 orders through the same curve code at their own notional and compare modelled one-way impact against each fill's stored `slippage_bps`. **This is a sanity check, not a validation** — 41 observations across 3 pools cannot validate a model, but they will catch a sign error, a units error or a factor of two. **Expected direction: modelled impact SMALLER than stored `slippage_bps`**, because slippage measures the fill against the decision-time mid and so also contains whatever the price did between t and t+1. **If modelled comes out LARGER, something is wrong — the quote is charging a cost the fill did not pay.** Record the comparison.
- [ ] T036 Quickstart scenario 6: run `git diff origin/main --stat -- packages/sim-executor/src/costs.ts packages/reports/src/promotion.ts packages/sim-executor/src/depth.ts .specify/memory/constitution.md` and assert it is **empty**. No fee value, no promotion threshold, no depth threshold, no constitutional wording changed.

---

## Phase 8: Polish

- [ ] T037 [P] Write `docs/ops/2026-09-16-cost-floor-distribution.md` recording the first real run's numbers with their date, so the distribution is citable the way the venue fee measurements are.
- [ ] T038 [P] Document in `packages/sim-executor/src/depth.ts`'s comment — **without changing the value** — that `DEFAULT_MAX_IMPACT_BPS = 34` is justified from the fee-**inclusive** `simExecutor.priceImpactBps` while being compared against the fee-**exclusive** `depth.priceImpactBps` (research.md R4). It has zero production consumers, so this is a documentation correction, not a behaviour change. **Do not change 34.**
- [ ] T039 Update `README.md`'s command list with `cost-floor`.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (T001-T002)** → **Foundational (T003-T006)** → everything else.
- **US1 (T007-T016)** is the MVP and blocks nothing else structurally, but US2 and US3 both extend the same module and are cheaper after it.
- **US2 (T017-T022)** depends on `costDistributions` existing (T011).
- **US3 (T023-T025)** depends on `costDistributions` existing (T011).
- **Phase 6 (T026-T031)** is fully independent of Phases 3-5 and can run at any point after Setup.
- **Phase 7 (T032-T036)** requires Phases 3-6 complete.
- **T034 gates nothing and blocks everything downstream of it** — it is a stop, not a step.

### User story dependencies

US1, US2 and US3 are independently testable. US1 alone is a shippable MVP: it answers the question the feature exists for.

### Parallel opportunities

- T002 with T001.
- T004 and T005 together after T003.
- T007, T008, T009 together — same file, so coordinate, but they are independent assertions.
- T015 with T016.
- T017 with T018; T026 with the whole of Phases 3-5.
- T037, T038, T039 together.

---

## Implementation strategy

**MVP = Phase 1, 2 and 3 (US1).** That produces the per-route distribution with counts and dates, which is the number M6 gate 1 actually needs. US2 makes it trustworthy, US3 makes it consumable.

**Phase 6 can and should go early.** It is independent, it is the control for the defect that motivated the spec, and running it early means the recorded failure (T030) is available while the rest is still being written.

**Expect T033 to be the interesting one.** The predictions in R9 exist so that its output is read against something written before the code, rather than judged after the fact by whoever wanted a particular answer.
