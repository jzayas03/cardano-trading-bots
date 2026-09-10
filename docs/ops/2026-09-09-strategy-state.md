# Where the strategy actually stands

Date: 2026-09-09. A synthesis, not a new measurement — every number here is sourced below.

Read this before proposing a strategy, choosing an instrument, or planning M6. It exists because the
day's findings are spread across five documents and the conclusion is not what any of them says on
its own.

## The one-line version

**Nothing measured clears its own cost floor.** The best instrument in the universe moves more than
it costs to trade in 11.9% of 2-hour windows, against a stablecoin noise floor of 8.3% — which is
inside noise. That is a finding, not a gap in the analysis.

## The method, which was wrong six ways this morning

Each of these was a real defect found and fixed on 2026-09-09. They are listed as rules because the
next analysis will be tempted by all six again.

1. **Measure in the currency you pay costs in.** Costs are ADA — batcher and network fees are ADA and
   the pool fee is charged against ADA reserves. The analysis was in USD, because GeckoTerminal
   defaults `currency` to `usd` and nobody passed one. SNEK looked 4x better than it is.
2. **Charge each instrument its OWN costs.** Pool fees range 30 to 300 bps and price impact scales
   with depth. Floors run from 198 bps (MIN) to 2,637 (AGIX). There is no such thing as *the* cost
   floor, and the 2.16% everyone quoted is NIGHT's.
3. **Validate a new method against a known result before trusting it.** The ADA query reproduced the
   superseded USD table to within 0.2 points on every token, so the differences were attributable to
   the denomination rather than to the method changing alongside the answer.
4. **Keep a control whose answer you already know.** A USD stablecoin priced against ADA *is* the
   ADA/USD rate, so it MUST move when the denomination changes. USDA went 0.8% -> 10.9%. A control
   that cannot fail is not a control.
5. **Prefer first-party measurement.** GeckoTerminal and DefiLlama disagreed about volume by 10x.
   Our own reserve deltas — a lower bound, which is the safe direction — corroborated GeckoTerminal
   and left DefiLlama the outlier.
6. **Distinguish "not measured" from "measured zero."** A single-sample candle reports a range of 0
   that was never observed. `opportunity` refuses to fold those into a denominator for this reason.

## What is measured

Floor = 2 x (pool fee + impact(depth) + 22 bps spread + 22 bps batcher). Calibrated on run 139's
real fill, which reproduces NIGHT's 216 bps exactly.

| token | fee | ADA depth | its floor | % of 2h windows clearing it |
|---|---|---|---|---|
| ASCEND | 100 | 850,412 | 477 | 11.9 |
| STRIKE | 100 | 1,307,542 | 411 | 11.6 |
| NIGHT | 30 | 2,359,348 | **216** | 9.5 |
| *USDA (control)* | 30 | 1,673,615 | 244 | *8.3* |
| **SNEK (what we trade)** | 100 | 1,941,419 | 371 | **6.8** |
| WMTX | 30 | 388,606 | 561 | 5.8 |
| MIN | 30 | 3,195,534 | 198 | 3.1 |

**We are trading the illiquid token.** SNEK's pool is idle in **207 of 222** five-minute intervals —
93% — and turns over ~49k ADA/day. NIGHT does ~6x that and is idle 22% of intervals. SNEK was chosen
for volatility and is the one that barely trades, which explains the flat candles, `opportunity`
reading 0.0% intra-candle, and RSI firing on numerical artefacts of a near-constant series.

**Arbitrage is priced out.** Implied ADA/USD dispersion across pools: median 12 bps, p90 36, on 170
hourly ticks — against a 216+ bps floor. USDA and USDCx never diverged past the floor in 279
observations (max 103 bps).

## What the strategy is, ranked by evidence rather than by what is built

**1. Being the maker.** The only path where the fee works for you. NIGHT/ADA turns over ~300k ADA/day
measured first-party (a lower bound) through a ~4.72M ADA pool at 30 bps: roughly 7-15% APR at
current volume, shared pro rata. The low volatility that makes NIGHT untradeable is the same property
that keeps impermanent loss small.

**It conflicts with the stated goal.** If NIGHT appreciates against ADA, an LP position ends up
holding *less* NIGHT than simply holding. Whether fee income beats that is a conviction about NIGHT,
not a measurement, and it belongs to the founder.

**2. Scheduled accumulation.** The zero-edge baseline: convert ADA to NIGHT on a calendar, pay one
one-way fee, require no signal. **Every other strategy has to beat this, and none has been shown to.**
It is the honest benchmark, and as of 2026-09-09 it **is** implemented: `scheduled-accumulation`,
buying `buyAda` once per `periodHours` and never selling (defaults 100 ADA / 24h). It has not
yet been RUN — the live paper runs stay as they are until the 7-day window closes.

**3. Directional taking.** What is running. Needs predictive skill AND has to clear 216-371 bps per
round trip. The 7-day run is the only test of the sufficient condition; everything above is necessary
conditions only.

**4. Arbitrage.** Measured dead at this cost structure. Do not re-derive it.

## NIGHT has a supply schedule, and it is the missing dimension

Founder research, 2026-09-09. **This is not visible in any price series and nothing in this project
models it.**

NIGHT (Midnight) has a fixed **24 billion** supply. The community allocations — Glacier Drop and
Scavenger Mine — unlock across a **~360-day thawing window that began around 10 December 2025**, in
**four equal 25% tranches**: a randomised first unlock day inside the initial 90-day window, then
every 90 days after. Roughly **70% of total supply was circulating by mid-2026**, with the remainder
continuing on a roughly monthly cadence into 2027 and beyond, plus a longer Lost-and-Found window and
other buckets.

**This probably explains the central puzzle in this document.** NIGHT/ADA clears its cost floor in
9.5% of 2 h windows — *below* a USD stablecoin's 8.3% — and we recorded that as "NIGHT tracks ADA
more tightly than the dollar does" without a mechanism. Continuous scheduled emission is a mechanism:
a persistent supply overhang caps upside and damps the pair, which is exactly the shape measured.

**And it gives "accumulate NIGHT" a calendar, which is the first timing signal in this project that
does not depend on beating the cost floor.** Every strategy examined here needs a price move larger
than 216-371 bps to pay for itself. An unlock schedule is different in kind: the dates are known in
advance, the direction of the supply pressure is known, and acting on it costs one one-way fee rather
than a round trip.

**What follows, and what does not.**

It does **not** follow that buying after an unlock is profitable — that is a claim about how much of
the supply is sold and how fast, which nothing here measures. What follows is narrower and firmer:

- **A scheduled accumulation rule should be aware of the tranche calendar** rather than being a naive
  fixed-interval buy. Buying into an unlock is buying into supply.
- **The 3-month price history this analysis rests on sits entirely inside the thawing window**, so
  every NIGHT figure in this document describes a token under active emission. It is not evidence
  about NIGHT after the schedule completes.
- **Nothing in the collector, the candles or the engine knows the schedule exists.** It would have to
  be entered as data — a small table of tranche dates — and that is a prerequisite for any
  calendar-aware rule, not a strategy in itself.

**Unverified here.** These figures come from founder research, not from a source this project reads.
The exact tranche dates, the randomised first-unlock date, and the current circulating percentage
should be pinned against Midnight's own published schedule before any rule is built on them — the
same standard applied to every other number in this document.

## Reading the token-denominated column

Every run report now carries `endTokens` / `returnTokenPct` beside the ADA columns. It is the ADA
return deflated by the price move — `(1 + returnPct) / (1 + priceChange) - 1` — and it answers the
question the ADA column cannot: **did this strategy end up with more NIGHT, or did NIGHT just move?**

Measured on the three finished NIGHT paper runs:

| run | strategy | ADA | tokens | fills |
|---|---|---|---|---|
| 137 | ma-crossover | 0.00% | +2.12% | 0 |
| 138 | rsi-mean-reversion | 0.00% | +2.12% | 0 |
| 139 | buy-and-hold | -3.10% | **-1.04%** | 1 |

Two readings, one of them a trap.

**Run 139 is the honest one.** Its -3.10% in ADA is only -1.04% in NIGHT: 2.06 of those points were
the token getting cheaper, which an accumulator does not care about. What remains is the cost of
entering, and it lands on the independently measured **108 bps one-way floor** — a different code
path arriving at the same number, which is the best corroboration the arithmetic has.

**Runs 137 and 138 are the trap.** They never traded. +2.12% is not skill; it is ADA buying 2.12%
more NIGHT after NIGHT fell. The column restates TOTAL equity in tokens, so idle cash tracks the
inverse price move. **Always read it beside `filled`.** A strategy that does nothing will look good
in this column in every falling market, and that is not the same as accumulating.

The column is comparable only WITHIN one token — the mixed-token warning applies harder here than to
the ADA columns, since two tokens' denominators are unrelated.

## What is still unknown, in the order it would change the answer

1. **Can clock-sampled reserves see the moves at all?** A pool trading once every ~84 minutes,
   sampled every 5 minutes, may be structurally unobservable to us. If so the instrument is the
   problem and no strategy fixes it. This is the deepest doubt and it is untested.
2. **Does anything survive a week?** Runs 146/147/148 finish ~16 September.
3. **Is direct cross-pair routing cheaper?** NIGHT/SNEK exists at $280k, so SNEK -> NIGHT is one swap
   rather than two. Spec'd, unmeasured.
4. **Does the unlock calendar actually move the price?** The schedule is known; whether tranche
   dates show up as measurable supply pressure is not. Testable against the price history we already
   have, once the dates are pinned.
5. **Venue integrity has no signal.** Nothing in this system can tell a healthy market from a
   compromised one; the Dano Finance case surfaced from the founder's own knowledge, not from
   anything we collect.

## Where the evidence is

| Claim | Source |
|---|---|
| ADA vs USD denomination, per-pool floors, the ranking | `docs/ops/2026-09-09-token-choice-ada.md` |
| The superseded USD table, kept and banner-marked | `docs/ops/2026-09-08-token-choice.md` |
| Cost floor derivation, risk controls, venue integrity | `docs/specs/2026-09-08-m6-execution.md` |
| Direct-route measurement design | `docs/specs/2026-09-09-cross-pair-collection.md` |
| Intra-candle opportunity, per token, re-runnable | `npm run opportunity -- <TICKER>` |

## What this does not claim

That no strategy can work — only that none of the ones examined has been shown to, on the data
collected so far, at the costs actually charged. Necessary conditions have been measured. The
sufficient condition is what the live week is for.

## The promotion gate

Founder sign-off 2026-09-09, **before the seven-day run's results existed**. That order is the point:
a gate chosen after seeing which side of it the results fall on is fitted to the answer, and this
project has already published one rate — 7.1% of fourteen windows — as though it were a finding.

Two rungs. `experimental` is the default; `candidate` is the highest anything here can reach, because
live trading is armed by hand. **The gate bars promotion, it does not warn.**

| Criterion | Threshold |
|---|---|
| Completed round trips (a round trip closes on a sell) | **30** |
| Window coverage | **80%** of expected buckets |
| Gaps over the stale-fill bound | **5%** of candles |
| Token-denominated return | strictly beats **both** `scheduled-accumulation` and `buy-and-hold` over the identical window |
| Every figure in the decision | measurable — a null return bars, it is not read as zero |

**Where 30 comes from.** NIGHT's median absolute two-hour move is 82 bps; for a roughly normal
distribution `median|X| ≈ 0.674σ`, so per-trade dispersion is about **122 bps**. Detecting an edge `e`
at 95% needs `n ≥ (1.96σ/e)²` — 6 round trips for a 100 bps edge, **23 for 50 bps**, 92 for 25 bps.
Thirty sits just above the 50 bps case, deliberately: an edge smaller than that cannot be told apart
from the cost floor's own error bar, whose batcher component is an assumption worth ±40 bps.

**The consequence, which is the point.** At the current fill rate a seven-day run yields roughly seven
round trips, so **a week promotes nothing**. The lever for a promotable answer is more instruments in
parallel, not a longer wait on one. It also puts `scheduled-accumulation` on the critical path: with
no baseline run over the window, nothing can clear the gate at all.

Measured against the three finished NIGHT runs the day it was built — all three barred, and for two
different reasons:

```
run 137 ma-crossover:       0 of 30 round trips
run 138 rsi-mean-reversion: 0 of 30 round trips
run 139 buy-and-hold:       buy-and-hold is a baseline, not a promotion candidate
```

## The n=30 threshold, checked against real fills

`npm run report -- <id>` now pairs filled buys to the sells that close them (FIFO) and reports the
run as a **distribution** of completed trades. Six small losses and one lucky win produce the same
run-level return as seven mediocre trades, and only one of those is a strategy.

It was built to check the promotion gate's own arithmetic. n=30 came from converting a median price
move into a σ via `median|X| ≈ 0.6745σ` — a conversion that holds **only** for a normal distribution,
which a reviewer flagged as unlikely for illiquid DEX pairs. Measured across three distinct corpora:

| corpus | round trips | excess kurtosis | measured σ ÷ normal-implied σ |
|---|---|---|---|
| run 3 | 83 | 8.38 | 1.02 |
| run 18 / 75 (NIGHT) | 162 | **13.06** | 1.29 |
| run 51 / 105 (USDA) | 148 | 2.54 | **0.63** |

**Fat tails are confirmed.** Every excess kurtosis is strongly positive against 0 for a normal, and
kurtosis is dimensionless — so that conclusion survives these corpora being external-candle
backtests priced in USD, where no σ figure could be quoted.

**But there is no correction factor.** The σ ratio runs 0.63 → 1.29: both directions, more than 2×
apart. Applying any single multiplier would be fitting to whichever corpus was looked at. The
parametric route to a sample size is the wrong tool, not a mis-tuned one.

**So 30 stands, unchanged**, on the same logic that set it: fixed before the data, and nothing
measured since gives a principled reason to move it. What replaces the conversion is a bootstrap
over actual round-trip returns — now buildable, and blocked only on having ADA-denominated round
trips to run it against, which is what the seven-day run will produce.

Incidental, and consistent with everything else here: median per-round-trip return was **−260 to
−342 bps** across all three corpora. These strategies did not lose narrowly.

## The bootstrap, and why BCa is not the default

A reviewer recommended replacing the plain percentile bootstrap with **BCa**, on the grounds that
percentile intervals under-cover in small, fat-tailed samples. That is the standard advice. **A
coverage simulation says it is not true in our regime.** 600 trials per row, 600 resamples, nominal
95%:

| distribution (n=30) | BCa | percentile |
|---|---|---|
| normal | 93.7% | 93.5% |
| exponential | 90.8% | 91.3% |
| lognormal (skewed) | **89.2%** | 88.2% |
| fat-tailed (symmetric) | **83.0%** | **90.2%** |
| fat-tailed, n=90 | 88.0% | 91.5% |

BCa is a near no-op on normal data and a genuine improvement on lognormal — which is what says the
implementation is correct rather than broken. But on **symmetric heavy tails it loses badly**, and
that is the shape our round-trip returns most resemble. The mechanism: the jackknife acceleration is
a third-moment estimate, and on a symmetric heavy-tailed sample the true correction is ~0 while any
particular sample's realised skew is large and driven by whichever outliers were drawn. BCa then
applies a noisy correction where none is wanted, shifting the interval randomly and costing coverage.

**So both intervals are computed and neither is the default.** `conservativeBounds` takes the union —
the widest bound — because a gate whose job is to refuse should take the reading that makes promotion
harder, and nothing should rest on picking a winner the evidence does not support. Where the two
disagree widely, that is itself information: the estimated skew is doing real work, so the shape
matters and the sample is probably too small to settle it.

**The row that matters most is the last column.** At n=30 on heavy tails, *no* bootstrap flavour
reaches 95% — they deliver 83–93%. That is a stronger statement about the promotion gate's sample
size than the σ-multiplier argument ever was, and it is the reason the gate's fifth criterion should
be read as directional until there are far more round trips than a week produces.

## Block resampling, and what it does not fix

A review noted the bootstrap resampled one round trip at a time, which assumes trades are
independent. They are not — they cluster by regime, by inventory, and by whatever the hour was
doing. Drawn singly, a run of correlated trades looks like many independent ones and the interval
comes out **too narrow**, which near a promotion boundary is the failure that admits a losing
strategy.

Unlike the BCa recommendation, this one survived its coverage simulation decisively. AR(1) returns,
true mean zero, 500 trials, nominal 95%:

| φ | n | iid | block | conservative + block |
|---|---|---|---|---|
| 0.0 | 30 | 92.2% | 88.4% | 91.4% |
| 0.3 | 30 | **81.2%** | 87.0% | 90.0% |
| 0.6 | 30 | **61.0%** | 75.6% | 79.4% |
| 0.6 | 90 | **68.0%** | **89.6%** | 90.4% |

**At moderate correlation the iid interval collapses to 61% coverage.** Blocking recovers 6 to 22
points and nearly reaches nominal once n is 90. Moving-block resampling with the `n^(1/3)` rule is
now the default, paired with a delete-one-**block** jackknife — an iid jackknife would estimate the
acceleration under exactly the assumption the sampler exists to abandon.

**It is not free.** At φ = 0 blocking costs about four points, because it discards independence that
was really there. It is still the default on the asymmetry: φ = 0 is the unlikely case for trade
returns, and a too-wide interval refuses a good strategy while a too-narrow one admits a bad one.

**And the row that matters most is φ = 0.6 at n = 30: 79.4%, even blocked and conservative.** At the
promotion gate's own sample size, correlated returns are not reliably intervalled by any estimator
here. That is now the third independent route to the same conclusion — after the σ-conversion check
and the BCa coverage table — and all three say the constraint is **the number of round trips**, not
the statistics applied to them.

## Staking, and why I oversold it

A review pointed out that idle ADA is not idle: delegated ADA keeps earning and stays spendable, so
every baseline that ignores it **understates the alternative** and makes every strategy look better
than it is. Conceded, and built — `report <id>` now shows the credit on every run.

It applies to **every run, not only the baselines**. A directional strategy sitting in cash between
trades earns it too; crediting only the comparator would be a different bias, not a fix. And it is a
measurement correction applied to equity, never paid into cash — paying it in would change what the
run could afford and make it a different run.

**I recommended this as "the only item that could change a conclusion." Having built it, the
measurement says it cannot at this horizon.** At the assumed 3% APR:

| window | fully idle, 1000 ADA | as a fraction |
|---|---|---|
| run 137, ~19 hours | 0.064 ADA | **0.64 bps** |
| one week | ~0.58 ADA | **5.75 bps** |
| one year | ~30 ADA | **300 bps** |

Against a 216 bps round-trip floor, a week of staking is a rounding error. **Over a year it is not:
300 bps exceeds the entire cost of a round trip.** So the correction is invisible in the seven-day
run and decision-relevant for anything held over months — which is precisely the horizon a
scheduled-accumulation or LP sleeve would be judged on.

The rate is **assumed, never measured**, in the sense the cost table uses the word: real yield
depends on protocol parameters and pool performance. Every report states which rate produced its
numbers, and it is shown beside the headline rather than folded into it — a headline that silently
depends on an assumption is how a number stops being questioned.
