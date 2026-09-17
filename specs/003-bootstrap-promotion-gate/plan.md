# Implementation Plan: Bootstrap the promotion gate's round-trip evidence

**Branch**: `feat/bootstrap-gate-plan` | **Date**: 2026-09-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-bootstrap-promotion-gate/spec.md` (merged as #178)

## Summary

Replace the gate's bare count of round trips against 30 with a **BCa bootstrap confidence interval on
the mean after-cost round-trip return**, passing only when the interval lies entirely above zero.

The load-bearing verification is done: **round-trip returns are already net of pool fee, price impact,
batcher fee and network fee** (research R1), so zero is the correct comparand and this feature never
reads the cost model. That is what makes the change safe to plan at all — the route by which it could
have touched the 216 bps floor does not exist.

Every parameter is pre-registered in [research.md](./research.md) before the procedure meets real
data: 95% two-sided, 10,000 resamples, minimum **12** round trips, one fixed PRNG seed. Predictions
for all six candidate runs are written down there too — all fail on the minimum, none reports an
interval.

## Technical Context

**Language/Version**: TypeScript, Node ≥ 24, ESM throughout

**Primary Dependencies**: none new. The interval is implemented in-repo; `vitest` is the test runner.
A bootstrap library was not considered — the procedure is ~60 lines and a dependency would be harder
to pin deterministically than to write.

**Storage**: none. This feature reads already-persisted orders through existing plumbing; no
migration, no schema change, no write.

**Testing**: `npm run test:pg` (RUN_PG_TESTS=1) is THE gate, plus `npm run lint` and `npm run lint:sh`.
`npm test` and `npx vitest` skip every Postgres test and are not evidence.

**Target Platform**: library code in `@ctb/reports`, surfaced by the existing `report --compare` CLI.

**Project Type**: monorepo library + CLI.

**Performance Goals**: 10,000 resamples × n ≤ a few hundred is milliseconds; the gate is called once
per run in a comparison table. No target beyond "not perceptible".

**Constraints**: `@ctb/reports` is PURE — a raw source-text guard forbids `pg`, `@ctb/db`, `@ctb/cli`,
`node:fs`, `node:net`, `node:http`, `node:child_process`. The interval belongs there, so it uses no
I/O and no ambient randomness. Determinism across processes is a hard requirement.

**Scale/Scope**: one new pure module, one rewritten check inside `promotionVerdict`, one input field,
one comment correction in `costFloor.ts`, two document updates. Seventeen ADA-denominated round trips
exist project-wide, so the near-term output is that nothing promotes.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Both passes below.*

| Principle | Verdict | Basis |
|---|---|---|
| **I. The cost model is measured, never asserted** | **PASS** | Research R1 establishes that returns are already after-cost, so the interval compares against zero and never reads `lookupFloor`, `VENUE_COSTS`, `DEFAULT_FLOOR_BPS` or `DEFAULT_MAX_IMPACT_BPS`. Quickstart carries a git-diff assertion over the cost-model files as an executable check, not a promise. |
| **II. Units are part of the number** | **PASS, and it is load-bearing** | The interval is computed on ADA-denominated paper fills only. The 739 SNEK "filled sells" are backtests over external USD candles — the corpus already recorded as one σ cannot be taken from. Feeding those in would compare a USD return to an ADA-costed zero, which is the exact failure Principle II names. |
| **III. Prove a filter in both directions** | **PASS** | A positive control (large consistent edge, few trips → MUST pass) and a negative control (30 mediocre trips that pass today's count → MUST fail) are both required tasks. The negative control is the one that proves this is not a relaxation. |
| **IV. `npm test` is not the gate** | **PASS** | `test:pg`, `lint`, `lint:sh`, all three green, or it is not implemented. |
| **V. The promotion gate exists in order not to be gamed** | **PASS — argued below, not asserted** | See the paragraph that follows; this is the principle the feature is closest to. |

### Principle V, and the Governance clause, addressed head-on

The constitution says a skill may not "relax the promotion gate", and requires a founder stop-and-ask
before "changing the promotion gate's thresholds or sample size". Both apply here and both are
satisfied, but the reasoning has to be visible rather than waved at:

1. **This was not skill-initiated.** The founder directed it on 2026-09-17, after being shown that
   the count has no significance test behind it and that the constant's own derivation is recorded as
   measured unsound. The stop-and-ask happened before any code was planned.
2. **It is not uniformly a relaxation, and for weak evidence it is stricter.** Thirty mediocre round
   trips pass today's check and fail the new one. What changes is that the bar becomes a function of
   the evidence: strong evidence clears sooner, weak evidence clears never. A count cannot express
   that at any value, which is why "lower the constant" was rejected in favour of this.
3. **Pre-registration — the property that made 30 defensible — is preserved, not discarded.** Every
   parameter is fixed in research.md ahead of contact with data, with its justification beside it,
   and the minimum of 12 sits above every run in the database, so it cannot have been fitted to let
   something through.
4. **The gate gets stricter in a second, unplanned way.** Research R8 found that `filledSells` counts
   sell *orders*, not paired round trips, and the two differ in both directions. Moving to paired
   trips corrects a miscount the current gate has always had.

**No exception is being requested**, so Complexity Tracking below is empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-bootstrap-promotion-gate/
├── spec.md              # merged as #178
├── plan.md              # this file
├── research.md          # Phase 0 — every pre-registered decision
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── promotion-evidence.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
packages/reports/src/
├── bootstrap.ts          # NEW — pure: seeded PRNG, BCa interval, normal CDF and its inverse
├── promotion.ts          # the round-trips check is rewritten; MIN_ROUND_TRIPS removed from the gate
├── compare.ts            # pairs round trips at the existing call site and passes the returns in
├── roundTrips.ts         # private quantile duplicate deleted in favour of the exported one
├── costFloor.ts          # comment-only: MIN_OBSERVATIONS states its own reason (no value change)
└── opportunity.ts        # unchanged — source of the reused `quantile`

packages/reports/test/
├── bootstrap.test.ts     # NEW — interval, determinism, degenerate cases, published test vectors
├── promotion.test.ts     # positive and negative controls; the 30-mediocre-trips case
└── noAmbientRandom.guard.test.ts   # NEW — raw source-text: `Math.random` appears nowhere

docs/ops/
├── 2026-09-16-parallel-instruments.md   # no longer asserts the bar stays at thirty
└── RUNBOOK-7day-run.md                  # same, line ~453
```

**Structure Decision**: everything computational lands in `@ctb/reports`, which is already the pure
layer and already where `promotion.ts` and `roundTrips.ts` live. **No new plumbing is created**:
`compare.ts:99` is the only non-test caller of `promotionVerdict` and already has `orders` in scope,
so pairing the round trips there is a local change. No CLI command is added — `report --compare`
already prints the verdict and every blocker.

## Complexity Tracking

> No constitution violations. No exceptions requested. Table intentionally empty.
