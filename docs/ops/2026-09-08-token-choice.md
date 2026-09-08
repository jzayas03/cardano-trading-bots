# Choosing the token the 7-day run trades

Date: 2026-09-08. Supersedes the NIGHT choice made the same day.

## The mistake

NIGHT was chosen because **73% of its candles showed a price change**, the highest in
`docs/ops/2026-09-07-first-real-candles.md`. That statistic answers "does the price move at all",
which is not the question. The question is whether it moves **more than it costs to trade** —
measured at **2.16% round trip** (`docs/specs/2026-09-08-m6-execution.md` §2).

Those are different questions and conflating them picked one of the worst instruments available.

## The measurement

54,050 GeckoTerminal candles, 18 tokens, 2026-06-01 to 2026-09-07, resampled to **one price per
hour** so a window is the same duration for every token, restricted to contiguous windows.

A first attempt compared moves over a fixed number of BARS and was thrown away: the external feed
writes no row without a trade, so a "bar" is ten minutes for NIGHT (14,386 bars) and hours for INDY
(564). It ranked the sparsest tokens highest, which is an artefact of their sparsity.

| token | 2h | 6h | 24h | 2h vol | deepest pool |
|---|---|---|---|---|---|
| ASCEND | 44.7% | 68.0% | 80.8% | 3.65% | 794k ADA |
| STRIKE | 43.0% | 57.7% | 73.5% | 3.69% | 1.32M |
| WMTX | 38.5% | 56.6% | 77.7% | 3.58% | 385k |
| **SNEK** | **35.1%** | **52.9%** | **74.5%** | 2.60% | **1.93M** |
| IAG | 31.0% | 55.6% | 71.7% | 2.55% | 397k |
| MIN | 12.6% | 29.1% | 62.2% | 1.49% | 3.18M |
| **NIGHT** | **10.3%** | **27.9%** | 55.9% | 1.78% | 2.28M |
| USDA | 0.8% | 1.6% | 2.7% | 0.67% | — |

Percent of windows whose absolute return exceeds 2.16%. **USDA at 0.8% is the control**: a
stablecoin against ADA should be nearly flat on this measure, and it is — which is the cheapest
available evidence that the method measures what it claims.

## The decision: SNEK

Not the top of the table. ASCEND and STRIKE move more but sit on pools less than half SNEK's depth,
and our own price impact is charged against that depth — 34 bps of the measured 86 bps slippage was
our own 990 ADA order moving the pool. SNEK is the best combination of **moves that clear the floor**
and **depth that keeps the floor low**.

## What this does not claim

That a strategy can capture those moves. It establishes only that moves of sufficient size **exist**
— a necessary condition, not a sufficient one. Whether any of the three strategies profits from them
is what the week measures, and this table cannot answer it.

Re-run this before choosing an instrument again; liquidity and volatility both drift.
