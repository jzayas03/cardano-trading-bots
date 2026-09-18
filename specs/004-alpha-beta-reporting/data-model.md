# Phase 1 data model

No persisted entities. Nothing is stored, migrated or written; every structure is computed in memory
from equity observations that already exist.

---

## EquityObservation (existing, reused)

One recorded point in a paper run's life.

| Field | Used for |
|---|---|
| `tickTs` | ordering, and the duration each return pair spans |
| `cashLovelace` | the idle-cash charge (R8) |
| `positionBase` | whether the run held exposure at all (R6 refusal) |
| `equityLovelace` | the strategy's ADA value — the regressand's source |
| `price` | the benchmark's ADA price — the regressor's source |

**Validation rules**

- **Paper runs only.** Backtests persist orders but no equity observations; the report states the
  measurement does not apply rather than printing an empty column.
- Observations must be ordered by `tickTs` and that order must be **stable**, or the pairing and the
  block resampling both become non-deterministic.
- `price` is the run's OWN recorded ADA price. Externally sourced history is USD and is forbidden
  (FR-003).

---

## ReturnPair (new)

The unit of evidence: one consecutive pair of tick observations.

> **REVISED 2026-09-17.** This was `CollapsedInterval`, merging consecutive observations that shared a
> benchmark price. Research R1's correction removed the collapse — the zeros are real, so there is
> nothing to merge and varying-duration intervals would have stopped alpha being a rate.

| Field | Notes |
|---|---|
| `fromTs` / `toTs` | one tick interval |
| `benchmarkExcessBps` | the token's ADA return over the tick, less the cash charge |
| `strategyExcessBps` | the run's ADA equity return over the SAME tick, less the cash charge |

**Validation rules**

- **Both series are measured over the same interval.** Measuring them over different spans is the
  most likely way to get this silently wrong, and it would fail no other assertion.
- A zero benchmark return is **valid data**, not an error. Roughly two thirds of them are zero
  because the pool went untraded, confirmed by the chain advancing while reserves held still.
- The cash charge is derived from `ASSUMED_STAKING_APR_PCT`, pro-rated to the tick's real duration —
  ticks can be missing, so a nominal length is not safe to assume.

---

## ExposureResult (new)

What the report prints. Carries its own provenance so a reader never has to assume a parameter.

| Field | Notes |
|---|---|
| `alphaBps` | fitted intercept, **ADA-denominated** |
| `alphaLowerBps` / `alphaUpperBps` | conservative bounds from the blocked pairs bootstrap |
| `beta` | fitted slope; unitless |
| `betaFirstHalf` / `betaSecondHalf` | split-window (R5), for FR-009. Each carries `degenerate`: a fully-invested half's equity tracks the price exactly, every residual vanishes and its interval collapses to a point (run 150, relative width 9.4e-5) |
| `observations` | return pairs used |
| `zeroBenchmarkPairs` | how many pairs had a zero benchmark return — the visible measure of how little the pool traded |
| `effectiveObservations` | `n_eff` per R4; **must be < `observations`** whenever `ρ > 0` (SC-004). Measured 2026-09-18: on live data `ρ ≤ 0`, so this discounts nothing — see `informativePairs` |
| `lag1Autocorrelation` | `ρ` of the regression RESIDUALS, reported so the `n_eff` input is visible |
| `informativePairs` | pairs in which the benchmark moved. **Added 2026-09-18**: the count that actually falls (49 of 148 live), carrying the identification burden R4 had wrongly assigned to `n_eff` |
| `betaHalvesOverlap` | whether the half intervals overlap; **null** when either half is degenerate |
| `alphaSeedStable` | `bcaStability`: does alpha's interval hold across seeds. A numerical property, never a statement about the strategy |
| `assumedStakingAprPct` | the cash-charge rate, shown not folded (FR-006) |
| `exposedFraction` | fraction of the window holding a position — context for beta |

**Validation rules**

- Every numeric field that has a denomination **states it** (FR-004). `alphaBps` is ADA; `beta` is
  unitless; the gate's separate token-denominated return is never mixed with these or summed.
- `effectiveObservations` is floored at 1 and capped at `observations`.
- Bounds are finite. A `NaN` bound is a defect, not a value — it compares false against zero and
  would read as "cannot distinguish" for the wrong reason.
- When `alphaLowerBps <= 0 <= alphaUpperBps`, the report says the window **cannot distinguish alpha
  from zero** rather than presenting the point estimate as a finding (FR-010).

---

## Refusal (new)

Not every run yields a result, and the reason is part of the output.

| Reason | When |
|---|---|
| `not-applicable` | run type records no equity observations |
| `too-few-observations` | fewer than 2 return pairs |
| `benchmark-did-not-move` | no price change across the whole window |
| `no-position-taken` | beta is 0 **by construction**; labelled definitional, not a measurement of skill |
| `window-open` | run still in progress; a partial window is not a result |

**State transitions** — exactly one outcome per run, no default-bearing fallthrough:

```
no equity observations   -> not-applicable
run still running        -> window-open
never held a position    -> no-position-taken (beta 0, definitional)
< 2 return pairs         -> too-few-observations
zero price change        -> benchmark-did-not-move
otherwise                -> ExposureResult
```

> **ORDER CORRECTED 2026-09-18.** `benchmark-did-not-move` was drafted above `too-few-observations`.
> A single observation has no price change either, so that order reports an undefined slope where the
> honest answer is that there is nothing to fit yet. `window-open` is driven by a fact the CALLER
> passes (`runs.finished_at`) — the module cannot derive it from observations, and reading a clock
> would break the purity guard.

**The promotion verdict consumes none of this.** FR-012 requires its status, checks and blockers be
unchanged for every input, enforced by test.
