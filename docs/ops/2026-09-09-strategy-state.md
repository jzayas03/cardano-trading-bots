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
