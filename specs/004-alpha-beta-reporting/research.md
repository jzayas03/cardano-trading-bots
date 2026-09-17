# Phase 0 research — exposure-adjusted comparison

Measured against the live box on 2026-09-17, before any design was fixed. **R1 is the finding that
shapes everything else, and it arrived by checking rather than assuming.**

---

## R1 — 67.6% of benchmark returns are exactly zero, and they are an artefact

**Measured**, runs 150-153, day 1-2 of the current week:

| | |
|---|---|
| equity points per run | 137 |
| distinct prices | 45 |
| consecutive pairs | 136 |
| **pairs with an identical price** | **92 (67.6%)** |

Ticks land every **900 seconds**, and `COLLECT_INTERVAL_SECONDS=900` — so there is **no interval
mismatch**, which was the first hypothesis and it was wrong. Consecutive ticks simply repeat the last
price in runs of two to five:

```
22:30  0.002146431461552144
22:15  0.002149616523928831
22:00  0.002149616523928831
21:45  0.002149616523928831
21:30  0.002149616523928831
21:15  0.002149616523928831
21:00  0.002148462937790246
```

The benchmark is a **stale price carried forward**, not a market that stood still.

**Why this is first-order rather than a nuisance.** A benchmark return measured with error attenuates
the regression slope: beta is biased **toward zero**, and the exposure it fails to attribute goes
straight into the intercept. **The bias manufactures alpha.** That is the same direction as the idle
cash problem FR-005 exists to prevent, arriving by a completely different route, and it is larger.

**Decision**: returns are computed over **price-change intervals**, not tick intervals. Consecutive
ticks carrying an identical price are collapsed into one observation spanning the whole stale
stretch, and the strategy's return is measured over that same span so the two series stay aligned.

**Rationale**: a tick whose benchmark price did not move carries no information about beta, and
including it as a zero both attenuates the slope and inflates the apparent sample. Collapsing keeps
every real price move and discards only the repetition.

**Alternatives considered**:

- *Regress at the tick interval and accept the bias* — rejected. It biases in the promoting
  direction, which is the one direction this project treats as unacceptable.
- *Resample to a fixed coarser grid (hourly, daily)* — rejected as arbitrary. Nothing says the price
  updates hourly; the observed runs are two to five ticks and will change with the collector's
  refresh behaviour. A fixed grid would be a guess that silently stops matching.
- *An errors-in-variables correction* — rejected for now. It needs an estimate of the measurement
  error's variance that this data cannot supply, and it would replace a visible problem with an
  invisible assumption.

**What the plan must still confirm**: WHY the price repeats. The likely cause is the collector's
refresh set — it prices the deepest venue every tick and others every Nth — or the candle builder
carrying the last close forward when no fresh snapshot landed. **It matters because if the repetition
is a collector cadence rather than a real absence of trading, the collapsed interval is measuring
what the collector saw and not what the market did**, and the report must say which.

---

## R2 — The estimator: excess-return regression, alpha as a fitted intercept

**Decision**: ordinary least squares of the strategy's excess return on the benchmark's excess
return, over the collapsed intervals from R1, with the cash charge as the risk-free leg. Alpha is the
**fitted intercept**, beta the slope.

**Rationale**: fitting the intercept rather than taking a residual mean is what makes alpha
"return not explained by exposure" instead of "return minus a guess at exposure". The two coincide
only when beta is already correct, which is the thing being estimated.

**Alternatives considered**: beta as a bare covariance ratio with alpha as a leftover (rejected —
same number when fitted jointly, but it invites the two to be computed from different samples);
a zero-intercept fit (rejected — it *assumes* alpha is zero, which is the hypothesis under test).

---

## R3 — The interval on alpha: pairs bootstrap, blocked, reusing the existing module

**Decision**: resample **pairs** — whole observation tuples of (benchmark excess, strategy excess) —
with the existing block resampler, and take `conservativeBounds` of the result.

**Rationale**: residual resampling assumes the residual variance does not depend on the regressor.
Crypto returns are heteroskedastic, so that assumption fails in the direction that narrows the
interval. Pairs keeps each observation's own noise attached to it. Blocks are required because
consecutive observations are dependent — the module's own AR(1) simulation shows iid coverage
collapsing to **61% at phi = 0.6**, which near a decision boundary is the failure that admits a bad
result.

**REUSE, do not reinvent.** `bcaInterval`, `conservativeBounds`, `bcaStability`, `mean`,
`BOOTSTRAP_RESAMPLES`, the seeded PRNG, Acklam's inverse normal and the block resampler all already
exist and are already tested. specs/003 wrote a spec, a plan and 46 tasks for a module that was
already present; this feature adds an estimator, not a resampler.

---

## R4 — Effective observations: a stated formula, not a hand-wave

**Decision**: report `n_eff = n × (1 − ρ) / (1 + ρ)`, where `n` is the number of collapsed
observations and `ρ` their lag-1 autocorrelation, floored at 1 and capped at `n`.

**Rationale**: it is the standard AR(1) variance-inflation adjustment, it is one line, and **its
assumption is nameable** — that the dependence is approximately first-order. A method whose
assumption cannot be stated is not better than this one, it is only harder to check.

Note the interaction with R1: collapsing already removes the zero-inflation, so `n_eff` measures
dependence among **real** price moves rather than the repetition. Reporting `n_eff` on the
uncollapsed series would have double-counted the problem.

**SC-004 requires `n_eff < n` whenever observations are correlated**, which this satisfies for any
`ρ > 0`. The lag-1 autocorrelation is reported alongside, so a reader can see the input.

---

## R5 — Beta instability: split-window, not rolling

**Decision**: fit beta on the first and second halves of the window separately and report both, plus
whether their intervals overlap.

**Rationale**: a strategy with time-varying exposure has no single honest beta, and the simplest
honest thing is to show that the number moved. A rolling estimate produces a curve that needs a plot
and invites eyeballing; two numbers and an overlap test can be read from a text report.

**This is NOT `bcaStability`.** That measures sensitivity to the resampling seed — whether the
interval is a numerical artefact. This measures whether the parameter itself drifted. Both are
reported, and the plan must keep the two labels distinct in the output, because conflating them would
let a stable-seed reading be quoted as a stable-exposure claim.

---

## R6 — Refusals, each with a stated reason

| Condition | Behaviour |
|---|---|
| Run records no equity (a backtest) | Report says the measurement does not apply to this run type. Not an empty column, not zeros. |
| Fewer than 2 collapsed observations | Refuse. No slope is defined. |
| Benchmark did not move at all across the window | Refuse. Beta is undefined and any alpha is the whole return mislabelled. |
| Never took a position | Report beta = 0 and label it **definitional** — the strategy held no exposure by construction, so this is not a measurement of skill. |
| Run still in progress | Report the window as OPEN. A partial window presented as a result is a finding that changes tomorrow. |

---

## R7 — Units: estimated in ADA, and never mixed with the token-denominated comparison

**Decision**: the regression is in **ADA**, using the run's own recorded price as the benchmark. The
gate's existing comparison stays **token**-denominated and is not touched.

**Rationale**: the mandate's return is token-denominated, and holding the token returns approximately
zero in token terms *by construction* — so a beta against it is only meaningful in ADA. External
price history is USD and is forbidden outright (FR-003): three months of USD rows were once read
against an ADA cost floor and looked entirely normal.

**The plan must make the two-denomination situation explicit in the OUTPUT, not only here.** A report
showing a token return and an ADA alpha side by side, unlabelled, is precisely how the earlier unit
error survived review. Every figure states its denomination.

---

## R8 — Cash charge: the existing rate, shown

**Decision**: charge idle cash at the existing `ASSUMED_STAKING_APR_PCT = 3`, converted to the
observation interval, and **print the rate beside the result**.

**Rationale**: a second assumed rate would drift from the first. The existing staking reporting
already refuses to fold this rate into a headline, for the reason that an assumption hidden inside a
number stops being questioned — and alpha is exactly the kind of number that gets quoted onward.

---

## R9 — Predictions, written before the measurement runs

Recorded per the spec's verification requirement. A result contradicting these is **investigated, not
accepted**.

At 137 points collapsing to roughly **45 real observations**, with two-thirds of the raw series
discarded as repetition:

1. **The interval on alpha will be far too wide to exclude zero** for all four runs. The spec already
   names this a legitimate outcome.
2. **`n_eff` will be materially below 45**, because real price moves are themselves correlated.
3. **150 (scheduled-accumulation) and 152 (buy-and-hold) will show beta near one**; they are
   essentially always long. If either does not, the estimator is wrong, not the strategy.
4. **151 and 153 will show beta well below one**, having spent much of the window in cash.
5. **Split-window betas will overlap widely**, because the window is short — which is honest, not a
   finding about stability.

Prediction 3 is the load-bearing one: it is the closest thing available to a known-answer test on
real data, because a strategy that holds the token must have a beta of one and anything else means
the measurement is broken.

---

## R10 — How it is verified without deploying

**Decision**: export the equity rows for runs 150-153 with a single read-only query and run the pure
functions locally, exactly as specs/003 did.

**Rationale**: a measurement week is in flight until roughly 23 September and the box runs a sha 35
commits behind. Deploying is forbidden, and a sidecar checkout costs an install competing with four
paper runs on a 2 GB box. The reports layer is pure, so running it against exported rows is faithful
rather than a workaround — that purity constraint is what makes this possible at all.

---

## Out of scope, restated so it stays out

- **Wiring alpha into the promotion gate.** A founder stop-and-ask. The verdict's status, checks and
  blockers must be unchanged, enforced by test.
- Any change to the cost model, the round-trip evidence check, or the 216 bps floor.
- Multi-factor attribution, risk-adjusted ratios, drawdown measures.
- Fixing the price repetition itself. R1 records what it is and works around it honestly; changing
  collector cadence is a different feature with its own quota arithmetic.
