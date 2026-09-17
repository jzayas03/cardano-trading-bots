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

1. **The pre-registered parameters are frozen** (research R5, as corrected by R12/R13): 95% two-sided,
   `BOOTSTRAP_RESAMPLES = 2_000` from the existing module, `MIN_TRIPS_FOR_INTERVAL = 12`, statistic is
   the arithmetic MEAN of `returnBps`, bounds are `conservativeBounds`, seed stability is checked
   across seeds 1/2/3 rather than one seed being pinned. **No task may change any of them.** If implementation suggests a
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

- [X] T001 Read `specs/003-bootstrap-promotion-gate/research.md` end to end before writing any code — it holds every pre-registered value and the reason for each, and the rest of these tasks assume it
- [X] T002 [P] Confirm the purity guard's current forbidden list in `packages/reports/test/` covers the new module's directory, and note (do not change) whether `Math.random` is already among the forbidden strings

---

## Phase 2: Foundational (Blocking Prerequisites)

> **REWRITTEN 2026-09-17 — T003-T015 were "build a BCa module". `packages/reports/src/bootstrap.ts`
> ALREADY EXISTS**, was built for this gate, is exported from `index.ts`, and is consumed by nothing.
> It already has mulberry32, Acklam's inverse normal, Numerical Recipes `erfc`, a jackknife, block
> resampling, a coverage simulation and `bcaStability`. The original tasks would have produced a
> second, worse implementation beside the reviewed one. See research R12. **The work is to WIRE what
> exists, not to build it.**

**Purpose**: confirm the existing module does what the gate needs, and add only what is missing.

- [X] T003 Read `packages/reports/src/bootstrap.ts` in full, including the header's coverage and AR(1) simulation tables, before touching anything — research R12/R13 depend on what it already establishes
- [X] T004 [P] Confirm `packages/reports/test/bootstrap.test.ts` already covers the PRNG, the normal CDF and its inverse against published values, and record in the PR what is already proven rather than re-asserting it
- [X] T005 [P] Verify the existing `bcaInterval` returns `null` below n = 2 rather than a fabricated interval, and that `conservativeBounds` takes the WIDEST of the BCa and percentile bounds
- [X] T006 Write a FAILING test in `packages/reports/test/bootstrap.test.ts` for the zero-variance case: 12 identical returns at r > 0 must yield finite, equal bounds. **`Number.isFinite` must hold** — a NaN bound compares false against zero and would fail the gate closed for the WRONG reason (research R6)
- [X] T007 SKIPPED — T006 passed against the existing module, which already handles zero variance; no fix invented. If T006 fails, fix the zero-variance path in `packages/reports/src/bootstrap.ts`. If it passes, say so in the PR and mark this task skipped rather than inventing work
- [X] T008 Export `MIN_TRIPS_FOR_INTERVAL = 12` from `packages/reports/src/promotion.ts` (the GATE's policy, not the module's) with the honest justification from research R5 — a pre-registered judgement, not a derivation, whose defence is that every run in the database has fewer trips than 12
- [X] T009 [P] Confirm `packages/reports/src/bootstrap.ts` contains no `Math.random`, no clock and no I/O, so the purity guard stays green with no change
- [ ] T010 REMOVED — mulberry32 already exists in `packages/reports/src/bootstrap.ts`
- [ ] T011 REMOVED — the normal CDF and Acklam inverse already exist in `packages/reports/src/bootstrap.ts`
- [ ] T012 REMOVED — the jackknife and BCa acceleration already exist in `packages/reports/src/bootstrap.ts`
- [ ] T013 REMOVED — `bcaInterval` already exists; the gate calls it through `conservativeBounds`
- [ ] T014 REMOVED — folded into T006
- [ ] T015 REMOVED — folded into T007

**Checkpoint**: the existing module is understood, its zero-variance behaviour is proven, and the
gate's own minimum is declared. **No second bootstrap implementation exists.**

---

## Phase 3: User Story 1 — a large obvious edge is promotable without waiting for thirty trips (Priority: P1) 🎯 MVP

**Goal**: the gate recognises unambiguous evidence early, and still refuses evidence that is merely
positive on average.

**Independent Test**: two constructed series — one with a large consistent edge and few trips, one
marginal with many trips. The first passes, the second fails, with no other check changed.

### Tests first

- [X] T016 [P] [US1] **POSITIVE CONTROL** — write a FAILING test in `packages/reports/test/promotion.test.ts`: ~12 consistently strongly-positive after-cost returns produce an interval entirely above zero and a PASSING `round-trips` check, whose detail reports the interval and the trip count
- [X] T017 [P] [US1] **NEGATIVE CONTROL, AND THE LOAD-BEARING TEST OF THIS FEATURE** — write a FAILING test in `packages/reports/test/promotion.test.ts`: THIRTY mediocre round trips whose interval spans zero must FAIL the check. **That identical input PASSES the count check being replaced.** This is the single test that proves the change is not a relaxation; if it ever goes green by passing, the feature has become the thing the constitution warns about
- [X] T018 [P] [US1] Write a FAILING test in `packages/reports/test/promotion.test.ts` for a series dominated by ONE large winner among losses — it must FAIL. This is the case BCa's skew correction exists for, and a percentile interval would be most likely to get it wrong

### Implementation

- [X] T019 [US1] Add `roundTripReturnsBps: readonly number[]` to `PromotionInput` in `packages/reports/src/promotion.ts`, KEEPING `filledSells` (the report prints it; removing it is unrelated churn) per research R8
- [X] T020 [US1] Rewrite the `round-trips` check in `packages/reports/src/promotion.ts` to call the EXISTING `conservativeBounds(bcaInterval(returns, mean, ...))` from `packages/reports/src/bootstrap.ts` — the widest of the BCa and percentile bounds, fail-closed, which that module's own header says the gate should use (research R3 superseded, R12) — and pass only when the conservative `lower > 0`. Keep the check id `'round-trips'` (research R8) — no type change, no consumer churn. **Exactly three outcomes and no default-bearing fourth**: baseline / below minimum / interval
- [X] T021 [US1] Remove `MIN_ROUND_TRIPS` from the gate's decision in `packages/reports/src/promotion.ts` and replace the long derivation comment with one recording that the constant was retired here, why (its parametric basis was measured unsound), and where the replacement is pre-registered
- [X] T022 [US1] Wire the call site in `packages/reports/src/compare.ts` (~line 99) to pair round trips from the `orders` it already destructures and pass their returns in. **Do not invent plumbing and do not add a CLI command** — this is the only non-test caller
- [X] T022b [US1] Make the check's detail state the coverage regime rather than implying a nominal 95% (research R13): the existing module measures 83-93% at n = 30 on heavy tails and 79.4% at phi = 0.6, and a gate that silently claims more precision than it has is the constitution's opening failure. Under-coverage means promoting too easily, so the real false-promotion rate is roughly 7-21%, not 5%
- [X] T022c [US1] Consult `bcaStability` in `packages/reports/src/promotion.ts` and REFUSE an interval whose bounds move more than `STABILITY_TOLERANCE` between seeds — that constant documents itself as the point above which an interval "is not to be trusted near a decision boundary", which is a principled small-n refusal needing no new constant
- [X] T023 [US1] Write a test in `packages/reports/test/promotion.test.ts` asserting `roundTripReturnsBps.length` CAN differ from `filledSells` and that the check uses the former: one sell can close several FIFO lots, and a sell with no open lot closes none, so the current gate has always miscounted in both directions (research R8)

**Checkpoint**: a strong edge clears below thirty, a marginal one does not clear at thirty.

---

## Phase 4: User Story 2 — the gate refuses on thin evidence, and says so legibly (Priority: P2)

**Goal**: every current run is refused, for a reason a human can read, distinguishing "not enough
trips" from "enough trips, and the answer is no".

### Tests first

- [X] T024 [P] [US2] Write a FAILING test in `packages/reports/test/promotion.test.ts`: with fewer than 12 trips the check fails, the detail names the count AND the minimum, and **NO interval appears in the detail** — a bound computed below the minimum would read as evidence
- [X] T025 [P] [US2] Write FAILING boundary tests in `packages/reports/test/promotion.test.ts` for BOTH sides: 11 trips fails on the minimum branch, 12 trips proceeds to the interval branch
- [X] T026 [P] [US2] Write a FAILING test in `packages/reports/test/promotion.test.ts` that the two failure details are DISTINGUISHABLE from each other by their text (FR-007), not merely both false
- [X] T027 [P] [US2] Write a test in `packages/reports/test/promotion.test.ts` that a baseline strategy short-circuits BEFORE any interval is computed, keeping today's behaviour that a baseline is never a candidate regardless of returns
- [X] T028 [P] [US2] Write NON-REGRESSION tests in `packages/reports/test/promotion.test.ts` asserting the two auditability properties still hold: EVERY check is reported passing or failing, and EVERY blocker is listed rather than only the first
- [X] T029 [P] [US2] Write a test in `packages/reports/test/promotion.test.ts` that an empty `roundTripReturnsBps` fails on the minimum branch as absence of evidence, distinct from the field being absent

### Implementation

- [X] T030 [US2] Implement the minimum branch and both detail strings in `packages/reports/src/promotion.ts`, reporting the interval only on the interval branch

### The real run — recorded, and checked against a prediction written in advance

- [X] T031 [US2] Run `npm run report -- --compare 147,149,146,153,151,6` READ-ONLY against the box from a checkout of this branch. Nothing is deployed, the live tree is not touched, runs 150-153 are not disturbed. Capture the output verbatim
- [X] T032 [US2] Check the captured output from T031 against the predictions in `specs/003-bootstrap-promotion-gate/research.md` (R9) written in advance: all six fail on the MINIMUM branch, **none reports an interval**, 150 and 152 fail earlier as baselines, nothing promotes. **A result contradicting this is INVESTIGATED, not accepted** — the likely benign explanation is that pairing produced more round trips than the sell count suggested (research R8), and that must be confirmed rather than assumed
- [X] T033 [US2] Record the observed output alongside the prediction in `docs/ops/2026-09-17-bootstrap-gate-first-run.md`, including which runs carried additional blockers

**Checkpoint**: every run in the database is refused, legibly, and the refusal was predicted before it
was observed.

---

## Phase 5: User Story 3 — the same evidence always produces the same verdict (Priority: P3)

**Goal**: a verdict that does not move between evaluations, and a guard that keeps it that way.

- [X] T034 [P] [US3] Write a test in `packages/reports/test/bootstrap.test.ts`: the same input evaluated twice IN ONE PROCESS yields byte-identical bounds
- [X] T035 [US3] Write a test in `packages/reports/test/bootstrap.test.ts` that a SEPARATE PROCESS yields the same bounds for the same input — a bootstrap stable only within one process is not deterministic, and **this is the assertion that actually matters**. Spawn a child that prints the bounds and compare, or pin the bounds as literal expected values committed in the test
- [X] T036 [P] [US3] Write `packages/reports/test/noAmbientRandom.guard.test.ts`: a raw source-text scan asserting `Math.random` appears nowhere under `packages/reports/src`
- [X] T037 [US3] Give that guard a **POSITIVE CONTROL** — a known-bad fixture string the detector must flag — in `packages/reports/test/noAmbientRandom.guard.test.ts`. This repo has already shipped a `shellcheck disable` bound to the wrong command that never worked; a detector nobody proved can detect is decorative
- [X] T038 [US3] Write a test in `packages/reports/test/bootstrap.test.ts` asserting the interval's own reported `confidencePct`, `resamples` and `trips` match the pre-registered constants, so SC-004 holds without reading the source

**Checkpoint**: the verdict is reproducible and the guard that keeps it so has been proven to fire.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T039 [P] Delete the private `quantile` duplicate at `packages/reports/src/roundTrips.ts` (~line 107) in favour of the exported one from `opportunity.ts`, taking the repository from four implementations to three. Consolidating the ones OUTSIDE `@ctb/reports` is out of scope
- [X] T040 [P] Correct the comment on `MIN_OBSERVATIONS` in `packages/reports/src/costFloor.ts` (~line 69) so it states its OWN reason instead of "matching the promotion gate's MIN_ROUND_TRIPS for internal consistency". **COMMENT ONLY — NO VALUE CHANGE.** Left coupled, this feature would drag the cost floor's sufficiency bar to 12, which is a cost-model change and a founder stop-and-ask, not a side effect (research R7)
- [X] T041 **STOP AND ASK** gate over `specs/003-bootstrap-promotion-gate/research.md` R5, `packages/sim-executor/src/costs.ts` and `.specify/memory/constitution.md`: if implementation produces any reason to change a pre-registered parameter, a cost value, or the stated 216 bps, STOP and raise it with the founder. Do not edit. Closed by confirming no such change was made
- [X] T042 [P] Update `docs/ops/2026-09-16-parallel-instruments.md` so it no longer asserts the bar stays at thirty, linking the reversal to this feature (FR-012)
- [X] T043 [P] Update `docs/ops/RUNBOOK-7day-run.md` (~line 453) so it no longer asserts the bar stays at thirty (FR-012)
- [X] T044 Run quickstart scenario 7: `git diff origin/main -- packages/sim-executor/src/costs.ts packages/sim-executor/src/depth.ts packages/reports/src/costFloor.ts .specify/memory/constitution.md` and confirm it is EMPTY except the comment-only `costFloor.ts` hunk. A value change here means the implementation went somewhere the plan did not
- [X] T045 Run the full gate set and repair until green: `npm run lint && npm run lint:sh && npm run test:pg`. Report failures with their output; citing `npm test` is citing the wrong suite
- [X] T046 Confirm the existing purity guard still passes and that `packages/reports/src/bootstrap.ts` introduced no I/O, no clock and no `node:crypto`

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
