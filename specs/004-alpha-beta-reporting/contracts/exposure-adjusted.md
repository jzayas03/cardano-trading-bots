# Contract: the exposure-adjusted measurement

`@ctb/reports` is a library, so its contract is its exported surface. Everything below is pure: no
I/O, no clock, no ambient randomness.

---

## `exposureAdjusted(observations, options?) -> ExposureResult | Refusal`

Alpha, beta and an interval on alpha for one paper run, against holding the token.

**Guarantees**

1. **Deterministic.** Identical observations yield byte-identical output, in this process and any
   other. The only randomness is the existing seeded PRNG.
2. **Total.** Every input produces either a result or a `Refusal` with a stated reason. There is no
   input that yields `undefined`, a thrown error the caller must catch, or a silently empty field.
3. **Finite.** Every numeric field is a finite number. `NaN` is a defect: it compares false against
   zero and would read as "cannot distinguish alpha from zero" for entirely the wrong reason.
4. **Self-describing.** The result carries `assumedStakingAprPct`, `observations`, `rawTicks`,
   `effectiveObservations` and `lag1Autocorrelation`, so no parameter has to be assumed by a reader.
5. **Pure.** No `Math.random`, no clock, no I/O. Two source-text guards already enforce this.

**Pre-registered parameters**: 95% two-sided and `BOOTSTRAP_RESAMPLES` from the existing module;
blocked resampling at its `n^(1/3)` default; cash charged at `ASSUMED_STAKING_APR_PCT`. `options`
exists for tests to pin smaller resample counts. **The report never passes options.**

**Refuses rather than guessing** on all five conditions in the data model, each with its own reason.

---

## What it does NOT do

- **It does not touch the promotion verdict.** `promotionVerdict`'s status, checks and blockers are
  unchanged for every input (FR-012), enforced by a test that compares before and after. This module
  is not imported by `promotion.ts` and does not import it.
- **It does not read the cost model.** No venue costs, no floor, no impact threshold.
- **It does not read external price history.** That is USD; the benchmark is the run's own ADA price.
- **It adds no CLI command.** The existing per-run report and comparison output carry it.

---

## Reported output

Every figure states its denomination. The block must make three things legible without the reader
consulting the source:

- **which numbers are ADA** (alpha and its bounds) **and which are unitless** (beta), alongside the
  gate's existing **token**-denominated return, which is NOT part of this measurement and is never
  summed with it;
- **the gap between raw ticks and collapsed observations**, which is the visible cost of the price
  repetition measured in research R1;
- **whether the window can distinguish alpha from zero at all** — when the interval spans zero the
  report says so instead of presenting the estimate as a finding.

Both stability notions appear and **must stay labelled apart**: seed stability (is the interval a
numerical artefact?) and split-window beta (did the exposure itself drift?). Conflating them would
let a stable-seed reading be quoted as a stable-exposure claim.

---

## Compatibility

**Not breaking.** The promotion input is unchanged, the verdict is unchanged, and the new fields are
additive on the report. A backtest, which records no equity observations, gains a stated
`not-applicable` rather than an empty column.
