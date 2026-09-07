# Universe backfill and three-strategy sweep, 2026-09-07

Machinery evidence, not a judgement of any strategy. Produced by `backfill ALL` and
`backtest ma-crossover,rsi-mean-reversion,buy-and-hold ALL --source external` on main at the
commits of PRs #28-#33, against the dev database on the founder's Mac. Every run id below is in
`runs`; `report <id>` reproduces its numbers.

## Backfill (GeckoTerminal, 2026-06-01 -> 2026-09-07 03:00 UTC)

- 19 of 20 tokens matched a pool; 18 of them by our own MinswapV2 pool identifier (possible only
  after the collector's discovery of 2026-09-07 stored those pools), SNEK and USDM by largest reserve.
- **SONG**: GeckoTerminal answers 404 for the token; no external history exists for it.
- **USDM**: matched a SaturnSwap pool that has no OHLCV rows; skipped by the sweep.
- 338 calls, 146+ rate limits absorbed at the old 3 s spacing (PR #31 widens spacing on 429 from the
  next run on). Coverage is sparse and uneven: NIGHT holds 14,398 five-minute rows over the window,
  COPI 127. GeckoTerminal writes a row only where a trade happened.

## Sweep (54 runs, 18 tokens, synthetic fill at each token's own latest deepest-pool ADA depth)

Coverage is the run's own `candles / expected 5-minute buckets` (PR #33; the first pass, runs 18-74,
measured it at the collector's 600 s interval and read about double). Returns and fills are
identical between the two passes, as they should be: only the denominator changed.

| token | strategy | run | depth ADA | coverage % | candles | return % | max DD % | filled / intents | fees ADA | warnings |
|---|---|---|---|---|---|---|---|---|---|---|
| NIGHT | ma-crossover | 75 | 2,329,579 | 50.9 | 14398 | -99.17 | 99.21 | 325 / 370 | 715.00 | 0 |
| NIGHT | rsi-mean-reversion | 76 | 2,329,579 | 50.9 | 14398 | -25.86 | 34.67 | 38 / 42 | 83.60 | 0 |
| NIGHT | buy-and-hold | 77 | 2,329,579 | 50.9 | 14398 | -33.65 | 67.41 | 1 / 1 | 2.20 | 0 |
| USDCx | ma-crossover | 78 | 352,073 | 10.0 | 2833 | -48.66 | 49.98 | 80 / 160 | 176.00 | 0 |
| USDCx | rsi-mean-reversion | 79 | 352,073 | 10.0 | 2833 | 0.7 | 8.45 | 3 / 4 | 6.60 | 0 |
| USDCx | buy-and-hold | 80 | 352,073 | 10.0 | 2833 | -2.64 | 43.19 | 1 / 3 | 2.20 | 0 |
| SNEK | ma-crossover | 81 | 1,914,381 | 18.3 | 5168 | -28.25 | 35.84 | 66 / 122 | 145.20 | 0 |
| SNEK | rsi-mean-reversion | 82 | 1,914,381 | 18.3 | 5168 | 4.62 | 15.66 | 8 / 9 | 17.60 | 0 |
| SNEK | buy-and-hold | 83 | 1,914,381 | 18.3 | 5168 | 6.47 | 44.83 | 1 / 4 | 2.20 | 0 |
| WMTX | ma-crossover | 84 | 387,480 | 9.8 | 2775 | -6.84 | 18.34 | 22 / 49 | 48.40 | 0 |
| WMTX | rsi-mean-reversion | 85 | 387,480 | 9.8 | 2775 | 6.65 | 20.92 | 13 / 27 | 28.60 | 0 |
| WMTX | buy-and-hold | 86 | 387,480 | 9.8 | 2775 | -8.18 | 49.06 | 1 / 1 | 2.20 | 0 |
| STRIKE | ma-crossover | 87 | 1,338,219 | 14.0 | 3959 | -39.13 | 45.48 | 52 / 88 | 114.40 | 0 |
| STRIKE | rsi-mean-reversion | 88 | 1,338,219 | 14.0 | 3959 | -11.4 | 31.16 | 10 / 12 | 22.00 | 0 |
| STRIKE | buy-and-hold | 89 | 1,338,219 | 14.0 | 3959 | -45.04 | 79.19 | 1 / 1 | 2.20 | 0 |
| AGIX | ma-crossover | 90 | 63,643 | 3.0 | 831 | -14.71 | 32.5 | 3 / 11 | 6.60 | 0 |
| AGIX | rsi-mean-reversion | 91 | 63,643 | 3.0 | 831 | -0.9 | 18.92 | 4 / 13 | 8.80 | 0 |
| AGIX | buy-and-hold | 92 | 63,643 | 3.0 | 831 | -38.27 | 66.73 | 1 / 1 | 2.20 | 0 |
| IAG | ma-crossover | 93 | 416,794 | 9.1 | 2557 | -3.82 | 31.14 | 13 / 34 | 28.60 | 0 |
| IAG | rsi-mean-reversion | 94 | 416,794 | 9.1 | 2557 | 1.26 | 11.51 | 5 / 16 | 11.00 | 0 |
| IAG | buy-and-hold | 95 | 416,794 | 9.1 | 2557 | -0.39 | 39.38 | 1 / 2 | 2.20 | 0 |
| HOSKY | ma-crossover | 96 | 546,157 | 4.5 | 1277 | 1.12 | 14.47 | 3 / 15 | 6.60 | 0 |
| HOSKY | rsi-mean-reversion | 97 | 546,157 | 4.5 | 1277 | -1 | 19.38 | 4 / 17 | 8.80 | 0 |
| HOSKY | buy-and-hold | 98 | 546,157 | 4.5 | 1277 | -27.82 | 45.13 | 1 / 1 | 2.20 | 0 |
| MIN | ma-crossover | 99 | 3,193,287 | 12.0 | 3397 | -13.1 | 24.63 | 29 / 55 | 63.80 | 0 |
| MIN | rsi-mean-reversion | 100 | 3,193,287 | 12.0 | 3397 | -14.24 | 19.56 | 8 / 21 | 17.60 | 0 |
| MIN | buy-and-hold | 101 | 3,193,287 | 12.0 | 3397 | -15.67 | 37.47 | 1 / 2 | 2.20 | 0 |
| LQ | ma-crossover | 102 | 479,965 | 2.0 | 551 | -6.35 | 12.02 | 4 / 9 | 8.80 | 0 |
| LQ | rsi-mean-reversion | 103 | 479,965 | 2.0 | 551 | 29.42 | 14.18 | 1 / 8 | 2.20 | 0 |
| LQ | buy-and-hold | 104 | 479,965 | 2.0 | 551 | 32.48 | 26.17 | 1 / 4 | 2.20 | 0 |
| USDA | ma-crossover | 105 | 1,660,203 | 24.9 | 7026 | -93.28 | 93.29 | 296 / 409 | 651.20 | 0 |
| USDA | rsi-mean-reversion | 106 | 1,660,203 | 24.9 | 7026 | 2.24 | 6.65 | 5 / 6 | 11.00 | 0 |
| USDA | buy-and-hold | 107 | 1,660,203 | 24.9 | 7026 | -0.74 | 20.72 | 1 / 1 | 2.20 | 0 |
| ASCEND | ma-crossover | 108 | 774,975 | 17.3 | 4892 | -11.16 | 51.33 | 55 / 96 | 121.00 | 0 |
| ASCEND | rsi-mean-reversion | 109 | 774,975 | 17.3 | 4892 | -16.09 | 40.89 | 14 / 22 | 30.80 | 0 |
| ASCEND | buy-and-hold | 110 | 774,975 | 17.3 | 4892 | 19.07 | 69.2 | 1 / 1 | 2.20 | 0 |
| NVL | ma-crossover | 111 | 568,121 | 1.3 | 367 | -11.79 | 27.11 | 1 / 7 | 2.20 | 0 |
| NVL | rsi-mean-reversion | 112 | 568,121 | 1.3 | 367 | 0 | 0 | 0 / 8 | 0.00 | 1 |
| NVL | buy-and-hold | 113 | 568,121 | 1.3 | 367 | -36.42 | 47.97 | 1 / 3 | 2.20 | 0 |
| STUFF | ma-crossover | 114 | 517,936 | 6.7 | 1893 | 57.72 | 18.92 | 10 / 27 | 22.00 | 0 |
| STUFF | rsi-mean-reversion | 115 | 517,936 | 6.7 | 1893 | 16.88 | 12.05 | 3 / 17 | 6.60 | 0 |
| STUFF | buy-and-hold | 116 | 517,936 | 6.7 | 1893 | 125.29 | 34.91 | 1 / 5 | 2.20 | 0 |
| SHEN | ma-crossover | 117 | 276,184 | 2.6 | 730 | 14.44 | 21.09 | 2 / 8 | 4.40 | 0 |
| SHEN | rsi-mean-reversion | 118 | 276,184 | 2.6 | 730 | -9.18 | 29.6 | 6 / 12 | 13.20 | 0 |
| SHEN | buy-and-hold | 119 | 276,184 | 2.6 | 730 | -32.42 | 67.12 | 1 / 3 | 2.20 | 0 |
| INDY | ma-crossover | 120 | 231,299 | 2.0 | 576 | 0 | 0 | 0 / 7 | 0.00 | 1 |
| INDY | rsi-mean-reversion | 121 | 231,299 | 2.0 | 576 | -9.23 | 23.23 | 2 / 17 | 4.40 | 0 |
| INDY | buy-and-hold | 122 | 231,299 | 2.0 | 576 | -25.02 | 51.69 | 1 / 1 | 2.20 | 0 |
| FLDT | ma-crossover | 123 | 1,667,749 | 2.5 | 693 | 3.81 | 3.71 | 1 / 8 | 2.20 | 0 |
| FLDT | rsi-mean-reversion | 124 | 1,667,749 | 2.5 | 693 | 22.23 | 15.28 | 4 / 20 | 8.80 | 0 |
| FLDT | buy-and-hold | 125 | 1,667,749 | 2.5 | 693 | -10.91 | 33.95 | 1 / 5 | 2.20 | 0 |
| COPI | ma-crossover | 126 | 18,843 | 0.5 | 127 | 0 | 0 | 0 / 2 | 0.00 | 1 |
| COPI | rsi-mean-reversion | 127 | 18,843 | 0.5 | 127 | -15.37 | 16.63 | 1 / 1 | 2.20 | 0 |
| COPI | buy-and-hold | 128 | 18,843 | 0.5 | 127 | -35.71 | 38.01 | 1 / 15 | 2.20 | 0 |

Skipped: USDM — external history is empty in this window (the matched pool has no OHLCV rows)
Skipped: SONG — no external history (run backfill first)

## How to read it

- **Coverage** first. A return over 0.5% of the window's buckets (COPI) is a handful of trades in a
  corpus with almost no rows; the stale-fill bound rejects most intents there. Under about 10%
  the numbers describe the corpus more than the strategy.
- **Fees** are the assumed synthetic-venue costs (2.2 ADA per fill) times fills: `ma-crossover`
  on NIGHT paid 715 ADA on 325 fills out of a 1,000 ADA start. High-frequency crossing on a
  falling corpus is the shape of that row.
- **warnings = 1** is the engine's own "emitted intents and none filled" (USDM before the skip
  rule; NVL/INDY/COPI rows with 0 fills) or, for USDM, zero candles.
- `buy-and-hold` is the baseline every other row is read against, per token.

## What this does not say

Nothing here is a recommendation. The fills are synthetic (declared depth, no observed reserves),
the corpora are sparse, and one window was used for everything. The local-candle path
(`--source candles`, observed reserves) has real snapshots only from 2026-09-07 onward and is the
comparison that matters after M1.
