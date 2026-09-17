---

description: "Task list for 004 — exposure-adjusted comparison, alpha and beta reported"
---

# Tasks: Exposure-adjusted comparison — alpha and beta, reported

**Input**: Design documents from `/specs/004-alpha-beta-reporting/`

**Prerequisites**: spec.md (#184), plan.md, research.md, data-model.md, contracts/, quickstart.md (#185)

**Tests**: TDD is REQUIRED. Every pure function and every guard gets a failing test first.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: US1, US2, US3 per spec.md

---

## Constraints that apply to EVERY task

Read once; not repeated per task.

1. **`@ctb/reports` stays PURE.** Two source-text guards enforce it — forbidden imports, and
   `Math.random` anywhere under `packages/reports/src`. No I/O, no clock, no `node:crypto`.
2. **REUSE, do not reinvent.** `bcaInterval`, `conservativeBounds`, `bcaStability`, `mean`,
   `BOOTSTRAP_RESAMPLES`, the seeded PRNG and the block resampler exist in
   `packages/reports/src/bootstrap.ts`. `quantile` is exported from `opportunity.ts`; three
   implementations remain after specs/003 removed one, and **a fourth is a defect**.
3. **No migration, no write, no new CLI command, no funds, no keys, no mainnet.**
4. **No change to the cost model** — venue costs, default floor, default max impact, the
   `round-trips` check, or the 216 bps floor. Any proposal is a **stop-and-ask** (T049), never an edit.
5. **Nothing is "implemented" until `npm run test:pg` AND `npm run lint` AND `npm run lint:sh` are
   green.** `npm test` and `npx vitest` skip every Postgres test and are not evidence.
6. **Wiring alpha into the gate is OUT OF SCOPE** and is a separate founder stop-and-ask.

---

## Phase 1: Setup

- [ ] T001 Read `specs/004-alpha-beta-reporting/research.md` end to end, R1 first — the 67.6% zero-return finding is why the design is what it is, and the rest of these tasks assume it
- [ ] T002 [P] Read `packages/reports/src/bootstrap.ts` including its header simulation tables, and list in the PR what it already provides so nothing here is rebuilt (the specs/003 lesson)
- [ ] T003 [P] Confirm `ASSUMED_STAKING_APR_PCT` in `packages/reports/src/staking.ts` is 3 and that `renderStaking` shows the rate rather than folding it in — the cash charge reuses that constant, never a second one

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the collapse from research R1, and the investigation that determines what the report is
allowed to claim. **No story work begins until this phase is green.**

### The investigation — it changes what the output may say

- [ ] T004 Determine WHY the benchmark price repeats across ticks, reading `packages/collector/src/tick.ts` and the candle builder: the candidates are the collector's refresh rotation (deepest venue every tick, others every Nth) and the builder carrying the last close forward when no fresh snapshot landed. Record the answer in `specs/004-alpha-beta-reporting/research.md` under R1
- [ ] T005 Record the consequence of T004 in `specs/004-alpha-beta-reporting/research.md` under R1: **if the repetition is a collector cadence rather than an absence of trading, the collapsed interval measures what the COLLECTOR saw, not what the market did**, and the report must say which. **Do NOT change collector behaviour** — that is a different feature with its own Blockfrost quota arithmetic

### Tests first — the collapse

- [ ] T006 [P] Write a FAILING test in `packages/reports/test/exposure.test.ts`: consecutive observations carrying an identical benchmark price collapse into ONE interval spanning the whole stale stretch
- [ ] T007 [P] Write a FAILING test in `packages/reports/test/exposure.test.ts`: `sum(ticksSpanned)` equals the raw observation count — nothing dropped, repetition merged
- [ ] T008 [P] Write a FAILING test in `packages/reports/test/exposure.test.ts`: **no collapsed interval has a zero benchmark return**. One that does means the collapse did not run
- [ ] T009 Write a FAILING test in `packages/reports/test/exposure.test.ts` that strategy and benchmark returns are measured over the **SAME spans**. This is its own task because measuring one per tick and the other per price change is the most likely way to get this silently wrong, and it would fail none of T006-T008

### Implementation

- [ ] T010 Create `packages/reports/src/exposure.ts` with the collapse to price-change intervals, producing `fromTs`, `toTs`, `ticksSpanned` per `specs/004-alpha-beta-reporting/data-model.md`
- [ ] T011 Implement excess returns in `packages/reports/src/exposure.ts`: benchmark and strategy ADA returns over each collapsed span, each less the cash charge for that span, **pro-rated to the interval's REAL duration and not to a nominal tick length**
- [ ] T012 Implement the cash charge in `packages/reports/src/exposure.ts` using `ASSUMED_STAKING_APR_PCT` from `packages/reports/src/staking.ts` — the existing constant, never a second one

**Checkpoint**: observations collapse correctly, both series share spans, and the repetition's cause
is written down.

---

## Phase 3: User Story 1 — tell skill apart from bought exposure (Priority: P1) 🎯 MVP

**Goal**: a reader can see whether a return came from judgement or from being long while the token rose.

**Independent Test**: a pure holder and a strategy with uncorrelated return produce visibly different
beta and alpha.

### Tests first

- [ ] T013 [P] [US1] **THE KNOWN-ANSWER CONTROL** — write a FAILING test in `packages/reports/test/exposure.test.ts`: a synthetic run whose equity tracks the token one-for-one MUST report beta within a stated tolerance of 1 and alpha within a stated tolerance of 0 after the cash charge. **A measurement that cannot recover beta = 1 from a pure holder is broken and every other number it prints is meaningless. DO NOT TUNE THE TOLERANCE TO MAKE IT PASS** — if it fails, the estimator is wrong
- [ ] T014 [P] [US1] **THE ATTENUATION DEMONSTRATION** — write a FAILING test in `packages/reports/test/exposure.test.ts`: regressing the UNCOLLAPSED series produces a **smaller beta and a larger alpha** than the collapsed one. This is what justifies the whole design; the measured 67.6% zero-return fraction biases beta toward zero and pushes unattributed exposure into the intercept, manufacturing alpha. A design nobody demonstrated is decorative
- [ ] T015 [P] [US1] **THE CASH-CHARGE CONTROL** — write a FAILING test in `packages/reports/test/exposure.test.ts`: a cash-only run reports alpha about zero, NOT a positive alpha equal to the token's decline
- [ ] T016 [P] [US1] Write a FAILING test in `packages/reports/test/exposure.test.ts`: a run that spent half the window in cash reports beta materially below 1, and the reported `exposedFraction` matches
- [ ] T017 [P] [US1] Write a FAILING test in `packages/reports/test/exposure.test.ts`: two runs with equal headline returns and different exposure report different alphas, in the direction the exposure difference implies

### Implementation

- [ ] T018 [US1] Implement the excess-return OLS in `packages/reports/src/exposure.ts`: beta the fitted slope, **alpha the FITTED INTERCEPT** — not a residual mean, because the two coincide only when beta is already right and beta is what is being estimated (research R2)
- [ ] T019 [US1] Implement the interval on alpha in `packages/reports/src/exposure.ts` as a **PAIRS** bootstrap — resample whole `(benchmarkExcess, strategyExcess)` tuples — **blocked**, via the existing `bcaInterval` and `conservativeBounds`. Residual resampling assumes homoskedasticity, which crypto returns violate in the direction that narrows the interval (research R3)
- [ ] T020 [US1] Implement `exposedFraction` in `packages/reports/src/exposure.ts` — the fraction of the window holding a position, reported as context for beta
- [ ] T021 [US1] Surface the result in `packages/reports/src/compare.ts`, which already destructures `equity` in the scope that builds the promotion input — **do not invent plumbing and do not add a CLI command**
- [ ] T022 [US1] Render the block in `packages/cli/src/commands/report.ts` using the existing per-run report surface

### Denominations — its own tasks, because this is how a units error survived review before

- [ ] T023 [P] [US1] Write a test in `packages/reports/test/exposure.test.ts` asserting every reported figure states its unit: **alpha and its bounds are ADA, beta is unitless**
- [ ] T024 [US1] Assert in `packages/cli/test/` that the rendered block labels the ADA alpha distinctly from the gate's existing **token**-denominated return, and that the two are never summed. A token return and an ADA alpha printed side by side unlabelled is exactly how the earlier units error survived review

**Checkpoint**: a pure holder returns beta ≈ 1, and the collapse is demonstrably why.

---

## Phase 4: User Story 2 — say plainly when the data cannot answer (Priority: P2)

**Goal**: distinguish "alpha is about zero" from "this window cannot tell you".

### Tests first — effective observations

- [ ] T025 [P] [US2] Write a FAILING test in `packages/reports/test/exposure.test.ts` for `n_eff = n * (1 - rho) / (1 + rho)`, floored at 1 and capped at n, with `rho` the lag-1 autocorrelation of the **COLLAPSED** series
- [ ] T026 [P] [US2] Write a FAILING test in `packages/reports/test/exposure.test.ts` for SC-004: `effectiveObservations` is **strictly below** `observations` whenever `rho > 0`
- [ ] T027 [P] [US2] Write a test in `packages/reports/test/exposure.test.ts` that `lag1Autocorrelation` is reported alongside, so the input to `n_eff` is visible rather than assumed

### Tests first — the refusals, five, no fallthrough

- [ ] T028 [P] [US2] Write a FAILING test in `packages/reports/test/exposure.test.ts`: a run recording no equity observations returns `not-applicable`, and the report SAYS so rather than printing an empty column or zeros
- [ ] T029 [P] [US2] Write a FAILING test in `packages/reports/test/exposure.test.ts`: a run still in progress returns `window-open` — a partial window presented as a result is a finding that changes tomorrow
- [ ] T030 [P] [US2] Write a FAILING test in `packages/reports/test/exposure.test.ts`: a benchmark that did not move across the whole window returns `benchmark-did-not-move`, because beta is undefined and any alpha is the whole return mislabelled
- [ ] T031 [P] [US2] Write a FAILING test in `packages/reports/test/exposure.test.ts`: a run that never held a position returns `no-position-taken` with beta 0 labelled **DEFINITIONAL**, not a measurement of skill
- [ ] T032 [P] [US2] Write a FAILING test in `packages/reports/test/exposure.test.ts`: fewer than 2 collapsed intervals returns `too-few-observations`
- [ ] T033 [US2] Write a test in `packages/reports/test/exposure.test.ts` that the five outcomes are exhaustive and mutually exclusive — exactly one per input, **no default-bearing fallthrough**

### The NaN path — its own task because it fails for the wrong reason

- [ ] T034 [US2] Write a FAILING test in `packages/reports/test/exposure.test.ts` that **no path produces NaN**, including a single collapsed interval and a zero-variance benchmark. A NaN bound compares false against zero and would read as "cannot distinguish alpha from zero" for entirely the wrong reason
- [ ] T035 [US2] Implement finite-guarantee handling in `packages/reports/src/exposure.ts` for every path T034 covers

### Split-window beta, and keeping the two stabilities apart

- [ ] T036 [P] [US2] Write a FAILING test in `packages/reports/test/exposure.test.ts`: beta is fitted on the first and second halves separately and both are reported, plus whether their intervals overlap (FR-009, research R5)
- [ ] T037 [US2] Write a test in `packages/reports/test/exposure.test.ts` that **split-window beta and `bcaStability` are labelled DISTINCTLY** in the output. They answer different questions — did the exposure drift, versus is the interval a numerical artefact — and conflating them would let a stable-seed reading be quoted as a stable-exposure claim

### Implementation and wording

- [ ] T038 [US2] Implement `n_eff`, the refusals and the split-window betas in `packages/reports/src/exposure.ts`. Note: collapsing already removed the zero-inflation, so computing `n_eff` on the UNCOLLAPSED series would double-count the problem
- [ ] T039 [US2] Implement the FR-010 wording in `packages/reports/src/exposure.ts` or its renderer: when the interval spans zero, say the window **cannot distinguish alpha from zero** rather than presenting the point estimate as a finding

### The real run — recorded, against a prediction written in advance

- [ ] T040 [US2] Export the equity rows for runs 150-153 from `run_equity` with ONE read-only psql query and run `packages/reports/src/exposure.ts` against them locally. **Nothing deployed, live tree untouched, runs 150-153 undisturbed** — a measurement week is in flight and the box runs a sha 35 commits behind. Capture the output verbatim
- [ ] T041 [US2] Check the T040 output against `specs/004-alpha-beta-reporting/research.md` R9: interval on alpha too wide to exclude zero on all four, `n_eff` materially below the ~45 collapsed observations, **150 and 152 showing beta near one**, 151 and 153 well below one, split-window betas overlapping widely. **PREDICTION 3 IS THE ONE THAT MATTERS** — 150 and 152 are essentially always long, so a beta far from one there means the ESTIMATOR is wrong rather than the strategy. **A contradicting result is INVESTIGATED, not accepted**
- [ ] T042 [US2] Record the observed output beside the prediction in `docs/ops/2026-09-XX-exposure-first-run.md`, including which runs refused and why

**Checkpoint**: the report distinguishes "about zero" from "cannot tell", and the first real reading is
recorded against what was predicted.

---

## Phase 5: User Story 3 — promotion outcomes are provably unchanged (Priority: P3)

**Goal**: the founder's condition for this feature existing, enforced by something other than intent.

- [ ] T043 [US3] Write a test in `packages/reports/test/promotion.test.ts` asserting `promotionVerdict`'s **status, checks and blockers are IDENTICAL** for every existing case — the feature is additive and must be provably so (FR-012)
- [ ] T044 [US3] Write a test in `packages/reports/test/promotion.test.ts` that a run with a strongly positive alpha is still barred when its other checks fail — **a strong alpha promotes nothing on its own**
- [ ] T045 [US3] Assert via `git diff origin/main -- packages/reports/src/promotion.ts` that the file is untouched apart from nothing — the only promotion-related change in this feature is a TEST

**Checkpoint**: the gate decides exactly what it decided before.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T046 [P] Write a test in `packages/reports/test/exposure.test.ts` that identical observations yield byte-identical output twice in one process
- [ ] T047 Write a test in `packages/reports/test/exposure.test.ts` pinning bounds as **literals produced by a SEPARATE node process** and committed — a bootstrap stable only within one process is not deterministic, and this is the assertion that catches ambient state
- [ ] T048 [P] Confirm both purity guards still pass and that `packages/reports/src/exposure.ts` added no I/O, no clock and no `node:crypto`
- [ ] T049 **STOP AND ASK** gate over `packages/sim-executor/src/costs.ts`, `packages/reports/src/costFloor.ts` and `.specify/memory/constitution.md`: if implementation produces any reason to change a cost value, a threshold, or the 216 bps floor, STOP and raise it with the founder. Do not edit. Closed by confirming no such change was made
- [ ] T050 Run quickstart scenario 8: `git diff origin/main -- packages/reports/src/promotion.ts packages/sim-executor/src/costs.ts packages/sim-executor/src/depth.ts packages/reports/src/costFloor.ts .specify/memory/constitution.md` and confirm it is EMPTY. Nothing that DECIDES anything changed
- [ ] T051 Run the full gate set and repair until green: `npm run lint && npm run lint:sh && npm run test:pg`. Report failures with their output; citing `npm test` is citing the wrong suite

---

## Dependencies & Execution Order

- **Phase 1 (Setup)**: no dependencies.
- **Phase 2 (Foundational)**: blocks ALL stories — every story needs the collapse. T004/T005 also block
  T022's wording, because what the report may claim depends on what the repetition turns out to be.
- **Phase 3 (US1)**: depends on Phase 2. **This is the MVP.**
- **Phase 4 (US2)**: depends on Phase 2; several tasks touch `exposure.ts` alongside US1 and follow it.
- **Phase 5 (US3)**: depends only on the feature existing; independent of US1/US2 internals.
- **Phase 6 (Polish)**: after the stories. T050 and T051 are last by construction.

### Within each story

Tests are written and MUST FAIL before the implementation that satisfies them.

### Parallel opportunities

- T006-T008 in parallel: independent assertions on the collapse.
- T013-T017 in parallel: five independent fixtures.
- T025-T032 in parallel: eight independent assertions.
- **Not parallel**: T010-T012, T018-T020, T035, T038, T039 all touch `exposure.ts` and are sequential.

---

## Implementation Strategy

### MVP (US1 only)

1. Phase 1 → Phase 2 → Phase 3.
2. **STOP and VALIDATE**: T013 recovers beta ≈ 1 from a pure holder, and T014 shows the uncollapsed
   series would have understated it.
3. That is a shippable increment: the report can distinguish skill from exposure, with the design's
   justification demonstrated rather than asserted.

### Incremental delivery

1. Setup + Foundational → observations collapse and the repetition's cause is known.
2. + US1 → alpha and beta are reported and the known-answer control passes. **MVP.**
3. + US2 → the report says when it cannot answer, and the first real reading is recorded.
4. + US3 → the gate is provably unchanged.
5. + Polish → determinism pinned across processes, nothing that decides anything touched.

---

## Notes

- **T013 and T014 are the point of the feature.** If either is weakened to make a suite green, the
  measurement has stopped being trustworthy regardless of what the other tests say.
- **T041 is a judgement task, not a formality.** A prediction that turns out wrong is information;
  accepting a contradicting result silently is the failure the prediction exists to prevent.
- Commit after each task or logical group.
