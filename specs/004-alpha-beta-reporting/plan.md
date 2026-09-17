# Implementation Plan: Exposure-adjusted comparison — alpha and beta, reported

**Branch**: `feat/alpha-beta-plan` | **Date**: 2026-09-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-alpha-beta-reporting/spec.md` (merged as #184)

## Summary

Report alpha, beta and an interval on alpha for each paper run, against holding the token, **without
changing what promotes**.

The plan's central finding is empirical and was measured before anything was designed: **67.6% of
consecutive benchmark returns are exactly zero**, because prices are carried forward across ticks
(research R1). That is not a nuisance — a benchmark measured with error attenuates the slope, so beta
is biased toward zero and the unattributed exposure lands in the intercept. **The bias manufactures
alpha**, the same direction as the idle-cash problem FR-005 exists to prevent, arriving by a
different route and larger.

So returns are computed over **price-change intervals** rather than tick intervals, the estimator is
an excess-return OLS with alpha as the fitted intercept, and the interval comes from a **blocked
pairs bootstrap** reusing the module that already exists.

## Technical Context

**Language/Version**: TypeScript, Node ≥ 24, ESM.

**Primary Dependencies**: none new. The estimator is a few dozen lines of arithmetic; the resampling
already exists in-repo. A statistics library was considered and rejected — it would be harder to pin
deterministically than to write, and the purity guard forbids most of what one would pull in.

**Storage**: none. Reads already-persisted equity observations. **No migration, no write.**

**Testing**: `npm run test:pg` (RUN_PG_TESTS=1) is THE gate, plus `npm run lint` and `npm run lint:sh`.
`npm test` and `npx vitest` skip every Postgres test and are not evidence.

**Target Platform**: pure library code in `@ctb/reports`, surfaced through the existing per-run report
and comparison output. **No new CLI command.**

**Performance Goals**: a few thousand resamples over ~45 observations, once per run in a table. Not
perceptible; no target beyond that.

**Constraints**: `@ctb/reports` is PURE — a source-text guard forbids `pg`, `@ctb/db`, `@ctb/cli`,
`node:fs`, `node:net`, `node:http`, `node:child_process`, and a second guard added by specs/003
forbids `Math.random` anywhere under `packages/reports/src`. Both must stay green.

**Scale/Scope**: one new pure module, one addition to the report rendering, no change to the gate.
Currently 137 observations per run collapsing to roughly 45 real ones; about 700 raw by week's end,
with real observations growing far more slowly.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1. Both passes below.*

| Principle | Verdict | Basis |
|---|---|---|
| **I. Cost model measured, never asserted** | **PASS** | This feature never reads the cost model. Quickstart carries a git-diff assertion over the cost files as an executable check. |
| **II. Units are part of the number** | **PASS, and it is the principle this feature is closest to** | The regression is in ADA on the run's own recorded price; external history is USD and is forbidden (FR-003). The gate's comparison stays token-denominated and the two are never mixed. Research R7 requires every reported figure to state its denomination **in the output**, because a token return and an ADA alpha printed side by side unlabelled is exactly how the earlier unit error survived review. |
| **III. A quoted price is not a market / prove a filter both ways** | **PASS** | R1 is this principle applied to the benchmark itself: a repeated price is not a market that stood still. The known-answer control in R9 prediction 3 — a token holder must show beta ≈ 1 — is the both-directions test. |
| **IV. `npm test` is not the gate** | **PASS** | `test:pg`, `lint`, `lint:sh`, all three green or it is not implemented. |
| **V. The gate exists in order not to be gamed** | **PASS — by construction** | The feature changes what the report SAYS and nothing about what the gate DECIDES. FR-012 requires the verdict's status, checks and blockers be unchanged for every input, enforced by test. Wiring alpha in later is a separate founder stop-and-ask, stated in the spec and restated here. |

**No exception is requested**, so Complexity Tracking is empty.

**One risk this check raises rather than resolves.** A reported alpha is the kind of number that gets
quoted onward, and it will be produced on evidence too thin to support it for at least several weeks.
The mitigations are FR-010 (say when the window cannot distinguish alpha from zero), FR-008 (report
effective observations, not raw), and R9's written-in-advance predictions. The feature is designed so
that its honest near-term output is "this window cannot answer".

## Project Structure

### Documentation (this feature)

```text
specs/004-alpha-beta-reporting/
├── spec.md              # merged as #184
├── plan.md              # this file
├── research.md          # Phase 0 — R1 is the finding that shaped the design
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── exposure-adjusted.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
packages/reports/src/
├── exposure.ts           # NEW — pure: collapse to price-change intervals, excess returns,
│                         #        OLS alpha/beta, n_eff, split-window betas
├── bootstrap.ts          # UNCHANGED — reused for the blocked pairs interval
├── staking.ts            # UNCHANGED — ASSUMED_STAKING_APR_PCT is the cash charge rate
├── compare.ts            # equity is already in scope at the call site; adds the reported fields
├── promotion.ts          # UNTOUCHED — the invariance is the point
└── opportunity.ts        # UNCHANGED — source of the reused `quantile`

packages/reports/test/
├── exposure.test.ts      # NEW — known-answer controls, collapse, refusals, determinism
└── promotion.test.ts     # gains the FR-012 invariance test; no existing case changes

packages/cli/src/commands/
└── report.ts             # renders the new block; denominations labelled
```

**Structure Decision**: the measurement is a pure function of already-recorded observations, so it
lives in `@ctb/reports` beside the round-trip and bootstrap modules. **No new plumbing**: `compare.ts`
already destructures `equity` in the same scope where it builds the promotion input, and the report
command already prints per-run detail. `promotion.ts` is deliberately not imported by the new module
and not modified by it — the only change there is a test.

## Complexity Tracking

> No constitution violations. No exceptions requested. Table intentionally empty.
