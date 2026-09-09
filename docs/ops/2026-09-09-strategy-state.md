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
It is the honest benchmark and it is not currently implemented.

**3. Directional taking.** What is running. Needs predictive skill AND has to clear 216-371 bps per
round trip. The 7-day run is the only test of the sufficient condition; everything above is necessary
conditions only.

**4. Arbitrage.** Measured dead at this cost structure. Do not re-derive it.

## What is still unknown, in the order it would change the answer

1. **Can clock-sampled reserves see the moves at all?** A pool trading once every ~84 minutes,
   sampled every 5 minutes, may be structurally unobservable to us. If so the instrument is the
   problem and no strategy fixes it. This is the deepest doubt and it is untested.
2. **Does anything survive a week?** Runs 146/147/148 finish ~16 September.
3. **Is direct cross-pair routing cheaper?** NIGHT/SNEK exists at $280k, so SNEK -> NIGHT is one swap
   rather than two. Spec'd, unmeasured.
4. **Venue integrity has no signal.** Nothing in this system can tell a healthy market from a
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
