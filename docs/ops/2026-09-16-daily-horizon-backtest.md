# The daily horizon does not work, and the one thing that beats the baseline needs two years to prove it

Date: 2026-09-16. Backtest over **5,258 SNEK candles, 2026-06-01 to 2026-09-09** — three months of
ADA-denominated GeckoTerminal candles at 5-minute base spacing, synthetic depth 1,880,391 ADA (SNEK's
own measured median ADA-side pool depth), 1,000 ADA starting cash.

Run to test the hypothesis from `2026-09-16-do-the-moves-clear-the-floor.md`: that a 15-minute
strategy cannot clear the cost of trading on this token and a **daily** one might.

**The hypothesis is wrong.** It is recorded here in full because it was written down first.

## Results

Parameterisations were fixed before the first run. One day = 288 candles at 5-minute spacing.

| strategy | params | intents | filled | return | max DD |
|---|---|---|---|---|---|
| **buy-and-hold** | default | 4 | 1 | **+20.47%** | 36.71% |
| scheduled-accumulation | default | 3 | 1 | +16.60% | 21.62% |
| ma-crossover | default (12/48) | 3 | 2 | **−2.66%** | 3.45% |
| **rsi-mean-reversion** | **default (period 14)** | 10 | 8 | **+41.08%** | **7.27%** |
| ma-crossover | 1d/3d (288/864) | 3 | 1 | +3.09% | 17.97% |
| ma-crossover | 1d/7d (288/2016) | 1 | 1 | +11.83% | 7.75% |
| rsi-mean-reversion | 1d (period 288) | **0** | 0 | — | — |
| rsi-mean-reversion | 2d (period 576) | **0** | 0 | — | — |

## What it says

**1. The daily horizon is dead, in both directions.** An RSI with a 288-candle period produces
**zero intents in three months** — it never reaches 30 or 70, because averaging over a day flattens
the series past the thresholds. ma-crossover at daily scales trades once or twice and returns 3.09%
and 11.83%, both well under buy-and-hold's 20.47%. Nothing at the daily horizon beats holding.

**2. The only thing that beats the baseline is the existing short-period RSI**, and it beats it
decisively on this sample: **+41.08% against +20.47%, with a drawdown of 7.27% against 36.71%.**
Better return and a fifth of the pain.

**3. Signal frequency, not candle spacing, sets the horizon — which is why this does not contradict
the opportunity analysis.** That analysis found 15-minute moves clear the cost floor 0.0% of the
time. The winning RSI runs on 5-minute candles, but it fires four times in a hundred days and holds
for one to four days:

| round trip | in | out | held |
|---|---|---|---|
| 1 | 2026-06-02 | 2026-06-03 | 1 day |
| 2 | 2026-06-04 | 2026-06-08 | 4 days |
| 3 | 2026-07-08 | 2026-07-10 | 2 days |
| 4 | 2026-07-24 | 2026-07-26 | 2 days |

A short candle period does not mean a short hold. What matters is how rarely the signal fires.

## The finding that matters most, and it is not about the strategy

**Four round trips in a hundred days is one every twenty-five days. The promotion gate requires
thirty. At this rate that is roughly seven hundred and fifty days — about two years.**

That is not a statement about SNEK or about RSI. It is a structural one: **a strategy that trades
rarely enough to beat the cost floor cannot accumulate thirty round trips in any timeframe the
project can wait for.** The gate's sample-size bar and this class of strategy are close to mutually
exclusive.

Both halves of that are load-bearing and neither should be relaxed casually. `MIN_ROUND_TRIPS = 30`
exists because an edge smaller than that cannot be told apart from the cost floor's own error bar.
Trading more often to reach it means trading at horizons where, as measured, the moves do not clear
the floor. **This tension is the real output of today's work**, and resolving it is a founder
decision, not an implementation one.

## Why the live runs said the opposite

Runs 147 and 149 returned −9.12% and −8.30% over seven days, and the same strategies return +41.08%
and −2.66% here. The differences are all of them:

- **Window.** Three months against seven days, and this window is a **rally** — buy-and-hold made 20.47%. In a rally almost anything that holds looks good, and the acceptance week had buy-and-hold at −1.20%.
- **Source.** GeckoTerminal external candles at 5-minute spacing, not our own 15-minute observations.
- **Fill model.** Synthetic depth at a single declared figure, not observed reserves.

None of those is a defect. They mean the two numbers answer different questions, and neither is
evidence about the other.

## What this rests on

**Four decisions.** The entire +41.08% is four round trips, all of them in June and July, with
nothing after 26 July. Any one of the four being luck changes the conclusion, and there is no way to
tell from this sample which they were.

One token, one three-month window, one market regime, external data, synthetic depth. **This is a
reason to look further, not a result.**

## Recommendation

- **Drop the daily-horizon hypothesis.** It was mine, it was specific, and it failed cleanly.
- **Do not act on the +41.08%.** Four round trips in a rally is not evidence, and the promotion gate exists precisely to stop a number like that being acted on.
- **Take the gate tension to the founder before anything else.** If a viable strategy trades once a month, thirty round trips is two years, and that has to be confronted rather than engineered around.
