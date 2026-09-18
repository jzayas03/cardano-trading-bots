# Alpha and beta's first run against real data, and the three predictions it broke

Date: 2026-09-18. specs/004 T040-T042, FR-008 through FR-010.

The predictions were written into `specs/004-alpha-beta-reporting/research.md` (R9) **before the
estimator existed**, so a contradicting result would be investigated rather than absorbed. Three of
the four were contradicted. This records both halves and what each contradiction turned out to be.

## How it was run

The box runs a sha 35 commits behind and a measurement week is in flight until roughly 23 September,
so **nothing was deployed and the live tree was not touched**. The equity rows for runs 150-153 were
exported with one read-only `SELECT` and the pure functions were run locally — faithful precisely
because `@ctb/reports` has no I/O. 596 rows, 149 observations per run, 2026-09-16 12:30Z to
2026-09-18 01:30Z at a 900 s tick. Runs 150-153 were not disturbed.

## Observed

```
run 150 scheduled-accumulation   beta 0.9549   alpha -1.047 bps ADA/tick  [-3.297,  0.474]  spans zero
run 151 rsi-mean-reversion       beta 0.0575   alpha -1.469 bps ADA/tick  [-3.881,  0.500]  spans zero
run 152 buy-and-hold             beta 0.9669   alpha -1.054 bps ADA/tick  [-3.254,  0.000]  spans zero
run 153 ma-crossover             beta 0.0624   alpha -2.220 bps ADA/tick  [-5.170, -0.526]  EXCLUDES zero

all four: 148 pairs, 49 informative, 99 zero-benchmark (66.9%)
n_eff:  148.0 / 125.2 / 147.9 / 145.8   of 148
seed stable: no / yes / no / no        exposed: 99% / 32% / 99% / 26%
```

**All four windows are still OPEN.** In the live report today every one of them refuses with
`window-open`; the numbers above were taken with that guard deliberately bypassed, and they are not
results yet.

## Prediction 3 — the one that mattered — HOLDS

R9 named this the load-bearing check: 150 and 152 are essentially always long, so a beta far from one
there would mean the **estimator** is wrong rather than the strategy. Measured: **0.955 and 0.967**,
against **0.058 and 0.062** for the two that sit in cash most of the window (32% and 26% exposed).
The estimator recovers the exposure structure on real data, not only on the synthetic control.

## Prediction 1 — "too wide to exclude zero on all four" — CONTRADICTED, and investigated

Run 153's interval excludes zero on the downside. Investigated rather than accepted:
its bounds **shift 7.5% of their own width across resampling seeds**, against a 5% tolerance, so the
exclusion is partly a resampling artefact. `bcaStability` — which exists for exactly this — flags it,
and the renderer now refuses to present a seed-unstable exclusion as a finding:

> the interval excludes zero, but it MOVES across resampling seeds — not quotable

Three of the four intervals are seed-unstable (0.127, 0.235, 0.075 against 0.05; only run 151 at
0.027 is stable), and for 150 and 152 the BCa and percentile methods disagree by two thirds of the
interval width. At 49 informative pairs that is the honest state.

## Prediction 2 — "n_eff materially below the raw count" — CONTRADICTED, and the design was wrong

`n_eff` came out at **148.0, 125.2, 147.9 and 145.8 of 148**. It discounts essentially nothing.

R4 and task T038 both asserted that a series two thirds zeros "is strongly dependent, so if `n_eff`
does not come out far below `n` the formula is on the wrong series". **That premise is false.** A
700-tick synthetic at the same 67.6% zero fraction gives lag-1 autocorrelation of −0.02 on the
benchmark returns, −0.06 on the strategy returns and −0.53 on the residuals: negative on all three.
No choice of series rescues it.

Zeros are **uninformative, not dependent**. They sit at the series mean and say nothing about their
neighbour, so the AR(1) variance-inflation adjustment passes straight over them. The live data's
problem is identification — 49 of 148 pairs saw the pool trade at all — and `n_eff` is not an
instrument for it.

`n_eff` is kept, unchanged and as pre-registered, because it is the right correction for the defect
it does address; quietly reparameterising it once it stopped flattering the design is the move the
constitution exists to prevent. What changed is the claim about what it carries. The report now
prints **both** counts, labelled apart, and the informative-pair count first.

## Prediction 4 — "split-window betas overlapping widely" — CONTRADICTED, and it was a defect

Runs 150 and 152 read as DISJOINT, which would have printed "the exposure drifted". The drift is real
— 0.715 → 0.997 and 0.835 → 0.992, both finishing their accumulation and then simply holding — but
the **evidence for it was not**. A strategy that is fully invested and merely holding has equity that
tracks the price exactly, so every residual vanishes and its second-half interval collapses to a
point: `[0.997, 0.997]`, relative width 9.4e-5.

The overlap test was therefore being won by an interval that contained no information. A degenerate
half now **disables** the comparison instead of winning it, and both point estimates are still
printed so the move remains visible. The degeneracy threshold was measured here rather than chosen:
the eight half intervals split four orders of magnitude apart, six real ones from 0.9 to 43 relative
width and two collapsed ones at 9.4e-5 and 2.6e-4.

## What this changes about promotion

**Nothing, and that is enforced by test.** `promotionVerdict`'s status, checks and blockers are
unchanged for every input (FR-012), `promotion.ts` is untouched, and no cost value, threshold or the
216 bps floor was read or altered. Wiring alpha into the gate remains a separate founder
stop-and-ask.
