# Phase 0 research — bootstrap the promotion gate's round-trip evidence

Every decision below is **pre-registered**: it is fixed here, before the procedure is run against any
real run. That is the property the superseded constant had and the only defence this feature has
against being tuned until something passes. FR-006 requires it; this file is the record.

---

## R1 — FR-003 verified: round-trip returns are already after-cost

**Decision**: Confirmed. Zero is the correct comparand. The interval must NOT subtract a cost floor.

**Evidence**, read from the code rather than the spec:

- `simExecutor.ts:115` — `amountOut = cpmmAmountOut(intent.amountIn, reserveIn, reserveOut, pool.feeBps)`.
  The **pool fee and the price impact are inside the fill price**.
- `roundTrips.ts:72` — `legFees = o.result.batcherFeeLovelace + o.result.networkFeeLovelace`.
- `roundTrips.ts:77` — buy lot cost is `amountIn + legFees`.
- `roundTrips.ts:83` — sell proceeds are `amountOut - legFees`.
- Both sides are split **pro rata by base units** on a partial close, so a partial carries its own
  share of the buy's fees and the sell's proceeds.
- `roundTrips.ts:60` — `returnBps = (proceeds - cost) / cost` in bps.

So `returnBps` is net of pool fee, price impact, batcher fee and network fee — every component of
the round-trip cost floor. **Subtracting the 216 bps floor again would charge costs twice**, which is
the same defect as the 2026-09-09 "pool fee 30 + impact 34 + spread 22" decomposition that specs/002
exists to prevent.

**Consequence for the plan**: nothing in this feature reads the cost floor. `lookupFloor` is not a
dependency. That also removes the only path by which this work could have touched the cost model.

---

## R2 — The statistic is the MEAN round-trip return, not the median

**Decision**: bootstrap the **arithmetic mean** of `returnBps`.

**Rationale**: the two choices answer different questions, and one of them is wrong here.

- The median asks "is the typical trip profitable?"
- The mean asks "does the strategy make money?"

A trend-following strategy — and `ma-crossover` is one of the four under test — has **many small
losses and a few large wins by construction**. Its median round trip is negative while its mean is
positive. Bootstrapping the median would systematically reject exactly the strategy family the
project is running, and would do it silently, looking like a statistical result rather than a
category error.

The mirror case is the reason not to dismiss this as a technicality: a strategy with many small wins
and rare large losses has a positive median and a negative mean. That is the blow-up profile, and a
median-based gate would promote it.

**Alternatives considered**: median (rejected above); trimmed mean (rejected — the trimming fraction
is a second free parameter with no principled value, and trimming a fat-tailed distribution discards
precisely the observations that decide whether the strategy works).

**Note on the usual objection**: the mean is sensitive to fat tails, and the tails here are severe
(excess kurtosis 8.38 / 13.06 / 2.54). That objection is why a *parametric* interval on the mean is
unsound — and it is the reason to bootstrap rather than a reason to change statistic. The bootstrap
inherits the sample's shape instead of assuming one.

---

## R3 — BCa, not the percentile interval

**Decision**: bias-corrected and accelerated (BCa) interval.

**Rationale — the direction of the error decides it.** The percentile bootstrap is simpler, but for a
skewed statistic at small n its coverage is **anti-conservative**: the interval is too narrow, so it
excludes zero more often than its nominal confidence claims. In a promotion gate that means
**promoting too easily**, which the constitution names as the most damaging failure available
("quietly relaxing a threshold... is most tempting and most damaging"). An error that makes the gate
stricter than advertised would be acceptable; this one is the other direction.

BCa corrects both the median bias and the skew, using a jackknife for the acceleration term.

**Cost, stated plainly**: BCa needs a jackknife loop (n extra means — trivial) and both the standard
normal CDF and its inverse. The inverse-normal is a numerical routine that has to be right; it will be
implemented from a published rational approximation and **pinned in tests against published values**,
not against its own output.

**Alternatives considered**: percentile (rejected — anti-conservative in the promoting direction);
basic/reverse-percentile (rejected — corrects bias but not skew, and skew is the dominant problem
here); studentised (rejected — needs a variance estimate per resample, and the variance of a
fat-tailed mean is exactly what is unreliable).

**If BCa proves intractable in implementation, that is a stop-and-report, not a silent downgrade to
percentile.** The choice above is the whole reason the interval can be trusted at small n.

---

## R4 — Determinism: one fixed, recorded seed and a PRNG in the pure layer

**Decision**: `mulberry32`, a four-line seeded PRNG, with a **single fixed seed constant** recorded
beside the other pre-registered parameters. `Math.random` is banned; `node:crypto` is not used.

**Rationale**: the verdict must be identical across processes, not merely within one (FR-005). A
fixed seed gives that, and it gives something else that matters more: **a seed that is a constant in
the source cannot be tuned per dataset without the tuning being visible in a diff.** That is the same
pre-registration property the rest of this file is protecting.

**Alternatives considered**:

- *Seed derived from the data* (e.g. a hash of the returns): also deterministic, and it avoids a
  fixed seed being "lucky" for one dataset. Rejected as strictly worse to audit — the seed then
  changes whenever the data changes, so a reviewer cannot tell a seed change from a data change.
- *No PRNG at all — enumerate the resamples*: the exact bootstrap distribution requires n^n
  multisets. Infeasible beyond trivial n, and rejected rather than left unconsidered.

**Guard**: a raw source-text test asserting `Math.random` appears nowhere in `packages/reports/src`,
using the same technique as the existing purity guard. A determinism test that only runs the current
code twice would pass forever after someone reintroduced ambient randomness somewhere else.

---

## R5 — The pre-registered parameters

| Parameter | Value | Why this value |
|---|---|---|
| Confidence | **95%**, two-sided | Matches the 1.96 the superseded derivation used, so this change alters the METHOD and not simultaneously the strictness. Changing both at once would make the effect of either unreadable. |
| Resamples | **10,000** | Standard for a 2.5% tail; Monte Carlo error on the bound is small relative to the sampling error the interval is reporting. Deterministic, so it is a cost and not a variance. At n in the tens this is milliseconds. |
| Minimum round trips | **12** | See below. |
| Statistic | mean `returnBps` | R2. |
| Interval | BCa | R3. |
| Seed | one fixed constant | R4. |

### The minimum, and an honest account of it

**12, and it is a judgement fixed in advance rather than a derivation.** Saying otherwise would
manufacture rigour, which is the failure this feature exists to correct.

What bounds it:

- Below roughly n = 10, BCa coverage is known to degrade for strongly skewed data — the jackknife
  acceleration is estimated from too few leave-one-out replicates to describe the skew.
- This project's own corpora sit at the severe end of skew (excess kurtosis 8.38, 13.06, 2.54), so
  the optimistic end of that range is not available.

What makes 12 defensible despite not being derived: **every run in the database has fewer round trips
than 12**, the largest being 8. The minimum therefore cannot have been fitted to let anything
through, because at this value nothing can pass regardless of its returns. That is a weaker claim
than a derivation and a stronger one than a round number.

It is also **not** 10, which would be the round number the spec forbids, and not 30, which is the
constant being replaced.

---

## R6 — Degenerate cases

| Case | Decision |
|---|---|
| Fewer than 12 round trips | Check FAILS. **No interval is computed or reported** — a number below the minimum would look like evidence. |
| Exactly 12 | PASSES the minimum (`>=`). Tested on both sides: 11 fails on the minimum, 12 proceeds to the interval. |
| Zero variance (every trip identical at `r`) | Every resample mean is `r`, so both bounds are `r`. If `r > 0` the interval excludes zero and the check passes — correct, since twelve identical positive trips are a consistent positive edge. **Implementation trap**: BCa's acceleration divides by the jackknife variance, which is 0 here. The code must detect it and return the degenerate interval `[r, r]` rather than `NaN`; a NaN bound would compare false against zero and silently fail closed for the wrong reason. |
| One dominant winner among losses | Must fail. This is the case BCa's skew correction exists for, and it is a required test. |
| Baseline strategy | The existing "baselines are not candidates" refusal takes precedence and short-circuits before any interval is computed. |
| No orders at all | Zero round trips → fails on the minimum, as absence of evidence. |

---

## R7 — Disposition of the old constant, and the second consumer

**Decision**: `MIN_ROUND_TRIPS` is **removed from the gate** and replaced by the new minimum.
`costFloor.ts`'s `MIN_OBSERVATIONS` is **deliberately DECOUPLED** and keeps 30 with its own rationale.

**Why decoupling is the only safe option.** `costFloor.ts:69` documents `MIN_OBSERVATIONS = 30` as
"matching the promotion gate's `MIN_ROUND_TRIPS` for internal consistency". They are separate
constants that happen to share a value and a comment — not a reference. Left "consistent", lowering
the gate's bar to 12 would drag the cost-floor sufficiency bar to 12 with it, which is **a change to
the cost model** and therefore a founder stop-and-ask, not a side effect of this feature.

They answer different questions, which is the substantive reason and not merely the safe one:

- The gate asks *how many round trips before an edge is distinguishable from luck*.
- The cost floor asks *how many price observations before a p90 is trustworthy*.

**Work required**: correct the comment at `costFloor.ts:69` so it states its own reason instead of
borrowing one. No value changes there.

---

## R8 — Check id and input shape

**Decision**: the check id stays `'round-trips'`. `PromotionInput` gains the returns; `filledSells`
stays.

**Id**: renaming to something like `'edge-evidence'` would describe the new behaviour better, but the
id is a stable identifier consumers match on and the meaning is carried by the `detail` string, which
this feature rewrites anyway. Renaming adds type churn across the report and tests without changing
behaviour. Recorded as the rejected alternative.

**A real defect found while reading, and it changes what gets passed in.** `filledSells` counts
*filled sell orders*, and the gate treats that number as the round-trip count — its own comment says
"Completed round trips: a round trip closes when the position is sold". **The two are not equal in
either direction**:

- one sell can close **several** FIFO lots, producing several round trips from one sell;
- a sell arriving with no open lot closes **nothing** — `roundTripStats` already counts these as
  `unmatchedSells`.

So today's check can both over- and under-count the evidence it claims to measure. The new check must
take **paired round trips**, not sell orders. `filledSells` remains in the input because the report
prints it and removing it is unrelated churn.

---

## R9 — Predictions, written before the procedure is run

Recorded per FR-010. A result that contradicts any line below is **investigated, not accepted**.

| Run | Strategy | Filled sells | Prediction |
|---|---|---|---|
| 147 | ma-crossover | 8 | FAILS on the minimum: fewer than 12 paired round trips, no interval reported |
| 149 | rsi-mean-reversion | 4 | FAILS on the minimum, no interval |
| 146 | rsi-mean-reversion | 2 | FAILS on the minimum, no interval |
| 153 | ma-crossover | 1 | FAILS on the minimum, no interval |
| 151 | rsi-mean-reversion | 1 | FAILS on the minimum, no interval |
| 6 | ma-crossover | 1 | FAILS on the minimum, no interval |

Also predicted:

- **No run reports an interval at all.** If one does, either the pairing produced more round trips
  than expected from its sells (possible — see R8, one sell can close several lots) or the minimum
  was not applied. Both need investigating before the output is believed.
- Runs 150 (scheduled-accumulation) and 152 (buy-and-hold) are **baselines**, and fail earlier as
  non-candidates rather than on evidence.
- Several runs will carry **additional** blockers (coverage, comparable). The verdict lists every
  blocker, not the first, so that is expected and is not a contradiction.
- **Nothing promotes.** Per the spec and Constitution Principle V, that is the design working.

---

## R10 — How the real check is run, without disturbing the measurement week

**Decision**: `report --compare`, read-only, on the box.

`printCompare` (`packages/cli/src/commands/report.ts:297`) calls `compareRunRows`, which is the only
non-test caller of `promotionVerdict`. It prints one row per run plus, under the table, the full
blocker sentence for every barred run — which is exactly the output FR-010 requires recording.

```
npm run report -- --compare 147,149,146,153,151,6
```

**Constraints on running it**: a measurement week is in flight. The command only reads, but it is a
node process on a 2 GB box, so it is run once, nice'd, with its output captured — and **nothing is
deployed**, meaning it runs from a checkout of this branch rather than by updating the live tree.

---

## R11 — Quantiles: consolidate two, leave the rest

**Decision**: reuse the exported `quantile` from `opportunity.ts:118`, and **delete the private
duplicate at `roundTrips.ts:107`** in favour of it.

Both live inside `@ctb/reports`, the duplicate is six lines of identical linear interpolation, and
this feature is already working in that module. That takes the repository from four implementations
to three. The remaining two are in other packages and consolidating them is **out of scope** — a
cross-package move is unrelated churn on a branch that changes the promotion gate.

Adding a fifth is a defect under FR-014 either way.

---

## Out of scope, restated so it stays out

- Giving `beats-baselines` its own significance test.
- Any change to `VENUE_COSTS`, `DEFAULT_FLOOR_BPS`, `DEFAULT_MAX_IMPACT_BPS` or the 216 bps floor.
  R1 removed the only route by which this feature would have touched them.
- Consolidating the quantile implementations outside `@ctb/reports`.
