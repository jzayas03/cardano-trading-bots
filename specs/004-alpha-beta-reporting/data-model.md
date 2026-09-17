# Phase 1 data model

No persisted entities. Nothing is stored, migrated or written; every structure is computed in memory
from equity observations that already exist.

---

## EquityObservation (existing, reused)

One recorded point in a paper run's life.

| Field | Used for |
|---|---|
| `tickTs` | ordering, and the span a collapsed interval covers |
| `cashLovelace` | the idle-cash charge (R8) |
| `positionBase` | whether the run held exposure at all (R6 refusal) |
| `equityLovelace` | the strategy's ADA value — the regressand's source |
| `price` | the benchmark's ADA price — the regressor's source |

**Validation rules**

- **Paper runs only.** Backtests persist orders but no equity observations; the report states the
  measurement does not apply rather than printing an empty column.
- Observations must be ordered by `tickTs` and that order must be **stable**, or the collapse in R1
  and the block resampling both become non-deterministic.
- `price` is the run's OWN recorded ADA price. Externally sourced history is USD and is forbidden
  (FR-003).

---

## CollapsedInterval (new)

The unit of evidence after research R1. Consecutive observations carrying an identical benchmark
price are merged into one interval spanning the whole stale stretch.

| Field | Notes |
|---|---|
| `fromTs` / `toTs` | the span; a collapsed interval can cover several ticks |
| `ticksSpanned` | how many raw observations were merged — the visible cost of the repetition |
| `benchmarkExcessBps` | the token's ADA return over the span, less the cash charge for that span |
| `strategyExcessBps` | the run's ADA equity return over the SAME span, less the cash charge |

**Validation rules**

- **Both series are measured over the same span.** Measuring the strategy per tick and the benchmark
  per price change would compare different windows and is the most likely way to get this silently
  wrong.
- A collapsed interval's benchmark return is **non-zero by construction** — that is the point. An
  interval with a zero benchmark return means the collapse did not run.
- `sum(ticksSpanned)` must equal the raw observation count. Nothing is dropped; repetition is merged.
- The cash charge is derived from `ASSUMED_STAKING_APR_PCT`, pro-rated to the interval's real
  duration, not to a nominal tick length.

---

## ExposureResult (new)

What the report prints. Carries its own provenance so a reader never has to assume a parameter.

| Field | Notes |
|---|---|
| `alphaBps` | fitted intercept, **ADA-denominated** |
| `alphaLowerBps` / `alphaUpperBps` | conservative bounds from the blocked pairs bootstrap |
| `beta` | fitted slope; unitless |
| `betaFirstHalf` / `betaSecondHalf` | split-window (R5), for FR-009 |
| `observations` | collapsed intervals used |
| `rawTicks` | raw observations before collapse — the two together show the repetition |
| `effectiveObservations` | `n_eff` per R4; **must be < `observations`** whenever `ρ > 0` (SC-004) |
| `lag1Autocorrelation` | `ρ`, reported so the `n_eff` input is visible |
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
| `too-few-observations` | fewer than 2 collapsed intervals |
| `benchmark-did-not-move` | no price change across the whole window |
| `no-position-taken` | beta is 0 **by construction**; labelled definitional, not a measurement of skill |
| `window-open` | run still in progress; a partial window is not a result |

**State transitions** — exactly one outcome per run, no default-bearing fallthrough:

```
no equity observations   -> not-applicable
run still running        -> window-open
zero price change        -> benchmark-did-not-move
never held a position    -> no-position-taken (beta 0, definitional)
< 2 collapsed intervals  -> too-few-observations
otherwise                -> ExposureResult
```

**The promotion verdict consumes none of this.** FR-012 requires its status, checks and blockers be
unchanged for every input, enforced by test.
