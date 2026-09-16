# Do SNEK's moves clear the measured floor? Only daily ones, and not the median day.

Date: 2026-09-16. `npm run opportunity` against 757 SNEK candles, 2026-09-08 to 2026-09-16, one
pool, 15-minute buckets — run at the **measured per-size floors** rather than the single 216 bps
constant it has always used.

This is the complement to `2026-09-16-cost-floor-distribution.md`. That one asked what a trade costs.
This asks whether the price moves more than that.

## The result

Percentage of windows whose move clears the floor:

| horizon | 216 bps (1,000 ADA) | **254 bps (500 ADA)** | 591 bps (100 ADA) |
|---|---|---|---|
| intra-candle, 15 min | 0.0% | **0.0%** | 0.0% |
| 30 min | 2.1% | **1.1%** | 0.0% |
| 2 hours | 7.4% | **6.2%** | 0.8% |
| 1 day | 36.2% | **30.7%** | 10.6% |

Median absolute move: **0 bps at 30 min, 29 bps at 2 h, 169 bps at 1 day.**

The middle column is the one that matters: `MIN_BUY_LOVELACE` is now 500 ADA, so 254 bps is what the
smallest order a strategy can place must beat.

## What it says

**1. At the timescale the strategies actually trade, there is nothing there.** ma-crossover and
rsi-mean-reversion decide on 15-minute candles. Intra-candle, **not one of 751 candles** clears even
the cheapest floor — the largest 15-minute range in eight days is about 25 bps, a tenth of the cost
of trading. At 30 minutes it is 1.1%.

This is the most plausible explanation yet for the acceptance week's results, where ma-crossover
returned −9.12% and rsi-mean-reversion −8.30% against buy-and-hold's −1.20%. **They were paying a
254 bps round trip to chase moves that clear it about once in ninety.** The cost model was not
penalising them unfairly; the timescale was.

**2. The edge exists, but only daily.** 30.7% of 1-day windows clear 254 bps. That is a real number
and it is the first evidence in this project that any horizon clears the cost of trading.

**3. The median day does not clear it.** The median 1-day move is **169 bps** against a 254 bps
floor. So a strategy that trades every day loses on the typical day; it has to trade only the top
third of days and know in advance which they are. That is the whole difficulty, restated in one
number.

**4. Raising the minimum order size mattered.** At the old 100 ADA minimum the floor is 591 bps and
only 10.6% of daily windows clear it. At 500 ADA it is 30.7%. Nearly tripling the fraction of
tradeable days by changing one constant is a larger effect than any strategy parameter has shown.

## Two things I got wrong on the way, both worth keeping

**The first run reported every multi-candle window as "skipped for gaps", and the data was fine.**
`opportunity` takes the candle interval from `COLLECT_INTERVAL_SECONDS`, which defaults to 600 s.
The collector writes 15-minute buckets: 754 of 756 gaps are exactly 900 s. Every window looked
discontinuous because the tool was told the wrong bucket size. **A "gap" report is a claim about the
configured interval as much as about the data** — check the spacing before believing it.

**The intra-candle zeros are real, though.** 755 of 757 candles have a high-low range between 0.00
and 9.54 bps. Only two exceed it, at 22.6 and 25.4 bps. SNEK's pool simply does not move inside 15
minutes.

## The caveat that limits all of this

**622 one-day windows do not mean 622 days.** They are rolling windows over **eight days** of
candles, overlapping almost completely. The 95% confidence interval printed beside them
(32.5-40.0%) is computed as though they were independent observations, and they are not. The honest
sample size for the daily figure is closer to **eight**.

So read 30.7% as "the daily horizon is the one worth investigating", not as a rate. Eight days is
also one market regime; SNEK in a different week may behave differently.

This is a limitation of the analysis and arguably of `opportunity` itself, which reports a Wilson
interval over overlapping windows. Worth fixing before the number is quoted anywhere that matters.

## What follows

**Before building M6 execution, test the daily horizon on paper.** The evidence says a 15-minute
strategy cannot clear the cost of trading on this token, and that a daily one might. That is a
backtest and a paper run, not execution engineering — and M6's own gate 1 requires a strategy to
clear the floor before any of it is built.

Nothing here says a daily strategy works. It says it is the only horizon where the question is still
open.
