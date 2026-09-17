---

description: "Task list for 003 — bootstrap the promotion gate's round-trip evidence"
---

# Tasks: Bootstrap the promotion gate's round-trip evidence

**Input**: Design documents from `/specs/003-bootstrap-promotion-gate/`

**Prerequisites**: spec.md (#178), plan.md, research.md, data-model.md, contracts/, quickstart.md (#179)

**Tests**: TDD is REQUIRED for this feature. Every pure function and every guard gets a failing test
first. A test written after the code it tests is not a test, it is a description.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: US1, US2, US3 per spec.md

---

## Constraints that apply to EVERY task

Read these once; they are not repeated per task.

1. **The pre-registered parameters are frozen** (research R5): 95% two-sided, 10,000 resamples,
   `MIN_TRIPS_FOR_INTERVAL = 12`, statistic is the arithmetic MEAN of `returnBps`, interval is BCa,
   one fixed recorded seed. **No task may change any of them.** If implementation suggests a
   different value, that is a **STOP AND ASK** (T041), never an edit — changing a parameter after
   seeing which runs pass is precisely the failure this feature exists to prevent.
2. **`@ctb/reports` stays PURE.** No I/O, no clock, no `node:crypto`, no `Math.random`. The existing
   purity guard must stay green.
3. **No migration, no write, no network, no funds, no keys.** Nothing here moves value.
4. **Nothing is "implemented" until `npm run test:pg` AND `npm run lint` AND `npm run lint:sh` are
   green.** `npm test` and `npx vitest` skip every Postgres test and are not evidence.
5. **A measurement week is in flight.** Nothing is deployed, the live tree is not touched, and runs
   150-153 must not be disturbed.
6. **`beats-baselines` gaining its own significance test is OUT OF SCOPE** and stays out.

---

## Phase 1: Setup

- [ ] T001 Read `specs/003-bootstrap-promotion-gate/research.md` end to end before writing any code — it holds every pre-registered value and the reason for each, and the rest of these tasks assume it
- [ ] T002 [P] Confirm the purity guard's current forbidden list in `packages/reports/test/` covers the new module's directory, and note (do not change) whether `Math.random` is already among the forbidden strings

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the numerical primitives every user story needs. **No story work begins until this
phase is green.**

### Tests first

- [ ] T003 [P] Write FAILING tests for a mulberry32-style seeded PRNG in `packages/reports/test/bootstrap.test.ts`: same seed yields the same sequence, different seeds yield different sequences, and every value lies in [0, 1)
- [ ] T004 [P] Write FAILING tests for the standard normal CDF in `packages/reports/test/bootstrap.test.ts` pinned against PUBLISHED values (Φ(0)=0.5, Φ(1.96)≈0.975, Φ(-1.96)≈0.025, Φ(2.576)≈0.995), with an explicit tolerance — **never against the function's own output**
- [ ] T005 [P] Write FAILING tests for the INVERSE normal CDF in `packages/reports/test/bootstrap.test.ts` pinned against PUBLISHED values (Φ⁻¹(0.975)≈1.959964, Φ⁻¹(0.025)≈-1.959964, Φ⁻¹(0.5)=0). A numerical routine validated by its own output is not validated
- [ ] T006 [P] Write a FAILING round-trip test asserting `normInv(normCdf(x)) ≈ x` across a spread of x in `packages/reports/test/bootstrap.test.ts` — this catches a sign or tail error that matching single points can miss
- [ ] T007 Write FAILING tests for the jackknife in `packages/reports/test/bootstrap.test.ts`: n leave-one-out means for n inputs, and the zero-variance case where every leave-one-out mean is identical
- [ ] T008 Write a FAILING test asserting `bcaMeanInterval` throws for fewer than 2 values in `packages/reports/test/bootstrap.test.ts` — no variance to resample, and guessing is worse than refusing

### Implementation

- [ ] T009 Create `packages/reports/src/bootstrap.ts` with the seeded PRNG and the fixed seed as a named exported constant, with a comment recording that the seed is pre-registered and why a constant beats a data-derived seed (research R4)
- [ ] T010 Implement the standard normal CDF and its inverse in `packages/reports/src/bootstrap.ts` from a published rational approximation, citing the source in a comment
- [ ] T011 Implement the jackknife and the BCa acceleration term in `packages/reports/src/bootstrap.ts`
- [ ] T012 Implement `bcaMeanInterval(returnsBps, options?)` in `packages/reports/src/bootstrap.ts` returning `{ lowerBps, upperBps, meanBps, trips, confidencePct, resamples }` per `contracts/promotion-evidence.md`; reuse the exported `quantile` from `packages/reports/src/opportunity.ts` and add no new quantile implementation (FR-014)
- [ ] T013 Export `MIN_TRIPS_FOR_INTERVAL = 12` from `packages/reports/src/bootstrap.ts` with the honest justification from research R5 in the comment — that it is a pre-registered judgement rather than a derivation, and that its defence is that every run in the database has fewer trips than 12, so it cannot have been fitted

### The NaN path — its own task because it fails closed for the wrong reason

- [ ] T014 Write a FAILING test in `packages/reports/test/bootstrap.test.ts` for zero variance: twelve identical returns at r > 0 must yield `lowerBps === upperBps === r`, and **`Number.isFinite` must hold on both bounds**
- [ ] T015 Implement zero-variance detection in `packages/reports/src/bootstrap.ts` so the acceleration term never divides by a zero jackknife variance; return the degenerate interval `[mean, mean]`. A `NaN` bound compares false against zero and would fail the gate closed for the WRONG reason, which is worse than failing loudly (research R6)

**Checkpoint**: the interval computes, is finite on every path, and its numerics are pinned to
published values rather than to themselves.

---

## Phase 3: User Story 1 — a large obvious edge is promotable without waiting for thirty trips (Priority: P1) 🎯 MVP

**Goal**: the gate recognises unambiguous evidence early, and still refuses evidence that is merely
positive on average.

**Independent Test**: two constructed series — one with a large consistent edge and few trips, one
marginal with many trips. The first passes, the second fails, with no other check changed.

### Tests first

- [ ] T016 [P] [US1] **POSITIVE CONTROL** — write a FAILING test in `packages/reports/test/promotion.test.ts`: ~12 consistently strongly-positive after-cost returns produce an interval entirely above zero and a PASSING `round-trips` check, whose detail reports the interval and the trip count
- [ ] T017 [P] [US1] **NEGATIVE CONTROL, AND THE LOAD-BEARING TEST OF THIS FEATURE** — write a FAILING test in `packages/reports/test/promotion.test.ts`: THIRTY mediocre round trips whose interval spans zero must FAIL the check. **That identical input PASSES the count check being replaced.** This is the single test that proves the change is not a relaxation; if it ever goes green by passing, the feature has become the thing the constitution warns about
- [ ] T018 [P] [US1] Write a FAILING test in `packages/reports/test/promotion.test.ts` for a series dominated by ONE large winner among losses — it must FAIL. This is the case BCa's skew correction exists for, and a percentile interval would be most likely to get it wrong

### Implementation

- [ ] T019 [US1] Add `roundTripReturnsBps: readonly number[]` to `PromotionInput` in `packages/reports/src/promotion.ts`, KEEPING `filledSells` (the report prints it; removing it is unrelated churn) per research R8
- [ ] T020 [US1] Rewrite the `round-trips` check in `packages/reports/src/promotion.ts` to compute the interval and pass only when `lowerBps > 0`. Keep the check id `'round-trips'` (research R8) — no type change, no consumer churn. **Exactly three outcomes and no default-bearing fourth**: baseline / below minimum / interval
- [ ] T021 [US1] Remove `MIN_ROUND_TRIPS` from the gate's decision in `packages/reports/src/promotion.ts` and replace the long derivation comment with one recording that the constant was retired here, why (its parametric basis was measured unsound), and where the replacement is pre-registered
- [ ] T022 [US1] Wire the call site in `packages/reports/src/compare.ts` (~line 99) to pair round trips from the `orders` it already destructures and pass their returns in. **Do not invent plumbing and do not add a CLI command** — this is the only non-test caller
- [ ] T023 [US1] Write a test in `packages/reports/test/promotion.test.ts` asserting `roundTripReturnsBps.length` CAN differ from `filledSells` and that the check uses the former: one sell can close several FIFO lots, and a sell with no open lot closes none, so the current gate has always miscounted in both directions (research R8)

**Checkpoint**: a strong edge clears below thirty, a marginal one does not clear at thirty.

---

## Phase 4: User Story 2 — the gate refuses on thin evidence, and says so legibly (Priority: P2)

**Goal**: every current run is refused, for a reason a human can read, distinguishing "not enough
trips" from "enough trips, and the answer is no".

### Tests first

- [ ] T024 [P] [US2] Write a FAILING test in `packages/reports/test/promotion.test.ts`: with fewer than 12 trips the check fails, the detail names the count AND the minimum, and **NO interval appears in the detail** — a bound computed below the minimum would read as evidence
- [ ] T025 [P] [US2] Write FAILING boundary tests in `packages/reports/test/promotion.test.ts` for BOTH sides: 11 trips fails on the minimum branch, 12 trips proceeds to the interval branch
- [ ] T026 [P] [US2] Write a FAILING test in `packages/reports/test/promotion.test.ts` that the two failure details are DISTINGUISHABLE from each other by their text (FR-007), not merely both false
- [ ] T027 [P] [US2] Write a test in `packages/reports/test/promotion.test.ts` that a baseline strategy short-circuits BEFORE any interval is computed, keeping today's behaviour that a baseline is never a candidate regardless of returns
- [ ] T028 [P] [US2] Write NON-REGRESSION tests in `packages/reports/test/promotion.test.ts` asserting the two auditability properties still hold: EVERY check is reported passing or failing, and EVERY blocker is listed rather than only the first
- [ ] T029 [P] [US2] Write a test in `packages/reports/test/promotion.test.ts` that an empty `roundTripReturnsBps` fails on the minimum branch as absence of evidence, distinct from the field being absent

### Implementation

- [ ] T030 [US2] Implement the minimum branch and both detail strings in `packages/reports/src/promotion.ts`, reporting the interval only on the interval branch

### The real run — recorded, and checked against a prediction written in advance

- [ ] T031 [US2] Run `npm run report -- --compare 147,149,146,153,151,6` READ-ONLY against the box from a checkout of this branch. Nothing is deployed, the live tree is not touched, runs 150-153 are not disturbed. Capture the output verbatim
- [ ] T032 [US2] Check the captured output from T031 against the predictions in `specs/003-bootstrap-promotion-gate/research.md` (R9) written in advance: all six fail on the MINIMUM branch, **none reports an interval**, 150 and 152 fail earlier as baselines, nothing promotes. **A result contradicting this is INVESTIGATED, not accepted** — the likely benign explanation is that pairing produced more round trips than the sell count suggested (research R8), and that must be confirmed rather than assumed
- [ ] T033 [US2] Record the observed output alongside the prediction in `docs/ops/2026-09-17-bootstrap-gate-first-run.md`, including which runs carried additional blockers

**Checkpoint**: every run in the database is refused, legibly, and the refusal was predicted before it
was observed.

---

## Phase 5: User Story 3 — the same evidence always produces the same verdict (Priority: P3)

**Goal**: a verdict that does not move between evaluations, and a guard that keeps it that way.

- [ ] T034 [P] [US3] Write a test in `packages/reports/test/bootstrap.test.ts`: the same input evaluated twice IN ONE PROCESS yields byte-identical bounds
- [ ] T035 [US3] Write a test in `packages/reports/test/bootstrap.test.ts` that a SEPARATE PROCESS yields the same bounds for the same input — a bootstrap stable only within one process is not deterministic, and **this is the assertion that actually matters**. Spawn a child that prints the bounds and compare, or pin the bounds as literal expected values committed in the test
- [ ] T036 [P] [US3] Write `packages/reports/test/noAmbientRandom.guard.test.ts`: a raw source-text scan asserting `Math.random` appears nowhere under `packages/reports/src`
- [ ] T037 [US3] Give that guard a **POSITIVE CONTROL** — a known-bad fixture string the detector must flag — in `packages/reports/test/noAmbientRandom.guard.test.ts`. This repo has already shipped a `shellcheck disable` bound to the wrong command that never worked; a detector nobody proved can detect is decorative
- [ ] T038 [US3] Write a test in `packages/reports/test/bootstrap.test.ts` asserting the interval's own reported `confidencePct`, `resamples` and `trips` match the pre-registered constants, so SC-004 holds without reading the source

**Checkpoint**: the verdict is reproducible and the guard that keeps it so has been proven to fire.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T039 [P] Delete the private `quantile` duplicate at `packages/reports/src/roundTrips.ts` (~line 107) in favour of the exported one from `opportunity.ts`, taking the repository from four implementations to three. Consolidating the ones OUTSIDE `@ctb/reports` is out of scope
- [ ] T040 [P] Correct the comment on `MIN_OBSERVATIONS` in `packages/reports/src/costFloor.ts` (~line 69) so it states its OWN reason instead of "matching the promotion gate's MIN_ROUND_TRIPS for internal consistency". **COMMENT ONLY — NO VALUE CHANGE.** Left coupled, this feature would drag the cost floor's sufficiency bar to 12, which is a cost-model change and a founder stop-and-ask, not a side effect (research R7)
- [ ] T041 **STOP AND ASK** gate over `specs/003-bootstrap-promotion-gate/research.md` R5, `packages/sim-executor/src/costs.ts` and `.specify/memory/constitution.md`: if implementation produces any reason to change a pre-registered parameter, a cost value, or the stated 216 bps, STOP and raise it with the founder. Do not edit. Closed by confirming no such change was made
- [ ] T042 [P] Update `docs/ops/2026-09-16-parallel-instruments.md` so it no longer asserts the bar stays at thirty, linking the reversal to this feature (FR-012)
- [ ] T043 [P] Update `docs/ops/RUNBOOK-7day-run.md` (~line 453) so it no longer asserts the bar stays at thirty (FR-012)
- [ ] T044 Run quickstart scenario 7: `git diff origin/main -- packages/sim-executor/src/costs.ts packages/sim-executor/src/depth.ts packages/reports/src/costFloor.ts .specify/memory/constitution.md` and confirm it is EMPTY except the comment-only `costFloor.ts` hunk. A value change here means the implementation went somewhere the plan did not
- [ ] T045 Run the full gate set and repair until green: `npm run lint && npm run lint:sh && npm run test:pg`. Report failures with their output; citing `npm test` is citing the wrong suite
- [ ] T046 Confirm the existing purity guard still passes and that `packages/reports/src/bootstrap.ts` introduced no I/O, no clock and no `node:crypto`

---

## Dependencies & Execution Order

- **Phase 1 (Setup)**: no dependencies.
- **Phase 2 (Foundational)**: blocks ALL user stories — every story needs the interval.
- **Phase 3 (US1)**: depends on Phase 2. **This is the MVP.**
- **Phase 4 (US2)**: depends on Phase 2; T030 touches the same file as T020, so it follows US1.
- **Phase 5 (US3)**: depends on Phase 2 only, and is genuinely independent of US1/US2 — it tests the
  interval, not the gate.
- **Phase 6 (Polish)**: after the stories. T044 and T045 are last by construction.

### Within each story

Tests are written and MUST FAIL before the implementation that satisfies them.

### Parallel opportunities

- T003–T006 in parallel: different pure functions, one test file, independent assertions.
- T016–T018 in parallel: three independent fixtures.
- T024–T029 in parallel: six independent assertions.
- T039, T040, T042, T043 in parallel: four different files, none touching the gate.
- **Not parallel**: T019–T022 all touch `promotion.ts` or its call site and must be sequential.

---

## Implementation Strategy

### MVP (US1 only)

1. Phase 1 → Phase 2 → Phase 3.
2. **STOP and VALIDATE**: the positive control passes, and — more importantly — the negative control
   FAILS the thirty-mediocre-trips input that today's count passes.
3. That alone is a shippable increment: the gate now measures evidence instead of counting.

### Incremental delivery

1. Setup + Foundational → the interval exists and its numerics are pinned.
2. + US1 → the asymmetry works. **MVP.**
3. + US2 → refusals are legible, and the real run is recorded against its prediction.
4. + US3 → the verdict is provably reproducible.
5. + Polish → docs stop contradicting the gate, and the cost model is proven untouched.

---

## Notes

- Commit after each task or logical group.
- The two controls in T016/T017 are the point of the whole feature. If either is weakened to make a
  suite green, the feature has failed regardless of what the other tests say.
- T032 is a judgement task, not a formality: a prediction that turns out wrong is information, and
  accepting a contradicting result silently is the failure mode FR-010 exists to prevent.
