# First candles and first observed-reserve backtest, 2026-09-07

The candle pipeline and the observed-reserve fill model had never run against real collector data
until now — every earlier backtest used the synthetic model over imported GeckoTerminal history.
This records what the first real run showed, because two of its findings change how the seven-day
paper run should be read.

Produced while the M1 collector was still running, from `npm run candles` and
`backtest … --source candles` against the dev database. No Blockfrost quota was used: both read
Postgres only.

## The candles are structurally sound

2,265 candles across all 20 tokens, from 2026-09-06 20:50 UTC to 2026-09-07 22:10 UTC. Every one of
them: `open = high = low = close`, non-null reserves, `pool_type = 'cpmm'`, non-null fee. The
equal-OHLC invariant is by construction — a candle is built from one snapshot per boundary, so there
is no intra-bucket range to record — and it is documented in `RUNBOOK-collector.md`. A spot check
against the underlying snapshot reproduced the close exactly from `reserve_quote / reserve_base`.

## Finding 1: prices move on a minority of ticks, and the rate varies enormously by token

| token | candles | distinct prices | moved | venues | which |
| --- | --- | --- | --- | --- | --- |
| NIGHT | 115 | 84 | 73.0% | 2 | MinswapV2 SundaeSwapV3 |
| USDA | 115 | 60 | 52.2% | 2 | MinswapV2 WingRidersV2 |
| ASCEND | 101 | 43 | 42.6% | 1 | MinswapV2 |
| USDM | 115 | 43 | 37.4% | 2 | MinswapV2 WingRidersV2 |
| SNEK | 115 | 37 | 32.2% | 2 | MinswapV2 WingRidersV2 |
| MIN | 115 | 27 | 23.5% | 2 | MinswapV2 SundaeSwapV1 |
| STRIKE | 115 | 23 | 20.0% | 2 | MinswapV2 SundaeSwapV3 |
| IAG | 115 | 19 | 16.5% | 2 | MinswapV2 WingRidersV2 |
| WMTX | 115 | 18 | 15.7% | 2 | MinswapV2 WingRidersV2 |
| STUFF | 115 | 17 | 14.8% | 2 | MinswapV2 WingRidersV2 |
| HOSKY | 115 | 14 | 12.2% | 2 | MinswapV2 SundaeSwapV1 |
| USDCx | 115 | 13 | 11.3% | 2 | MinswapV2 SundaeSwapV3 |
| SHEN | 115 | 11 | 9.6% | 2 | MinswapV2 WingRiders |
| AGIX | 115 | 8 | 7.0% | 3 | Minswap MinswapV2 SundaeSwapV1 |
| INDY | 115 | 8 | 7.0% | 2 | MinswapV2 SundaeSwapV1 |
| NVL | 101 | 6 | 5.9% | 1 | MinswapV2 |
| LQ | 115 | 5 | 4.3% | 2 | MinswapV2 SundaeSwapV1 |
| FLDT | 101 | 4 | 4.0% | 1 | MinswapV2 |
| COPI | 115 | 2 | 1.7% | 2 | MinswapV2 WingRidersV2 |
| SONG | 101 | 1 | 1.0% | 1 | MinswapV2 |

At a 600-second interval the deepest pool's reserves are unchanged on most ticks for most tokens.
The collector is not at fault — `observed_at` advances every tick, so it is re-reading; the pools
simply do not trade every ten minutes. SONG's price changed once in 101 candles; COPI's twice.

**What this means for the seven-day run.** A strategy on SNEK will see a price change on roughly a
third of its 1,008 candles. On NIGHT, on about three quarters. On SONG or COPI it would see almost
nothing and produce a result that describes the pool's illiquidity rather than the strategy. If the
run is meant to exercise the machinery, pick from the top of that table.

## Finding 2: a venue outage silently splices the price series across pools

**16 of the 20 tokens have had their deepest pool on two or more venues** in 25 hours; AGIX on three.
The cause is known: MinswapV2 was lost for about two hours on 2026-09-07 to a transient provider
error, and the candle builder — correctly, by its own rule — promoted whatever was next-deepest, then
moved back when MinswapV2 returned.

Two pools on the same token are not the same price series. They quote differently, hold different
depth, and cost different fees: one of these backtests paid 1.2 ADA per fill rather than 2.2 purely
because it filled on SundaeSwapV3 instead of MinswapV2. A strategy reading the spliced series sees a
price step that is a venue change, not a market move.

The information was never lost — every candle carries its `pool_id` — but nothing surfaced it. A run
now counts its distinct pools, reports them on the coverage line, and warns naming them when there is
more than one. Runs before that change report the count as not recorded rather than implying one.

## The first observed-reserve backtests

SNEK, 2026-09-06 20:00 to 2026-09-07 23:00, 115 candles, 75.2% coverage, max gap 200 minutes:

| strategy | run | filled / intents | return % | max DD % | fees ADA |
| --- | --- | --- | --- | --- | --- |
| ma-crossover | 129 | 2 / 2 | -1.88 | 1.88 | 4.40 |
| rsi-mean-reversion | 130 | 1 / 1 | -0.91 | 1.35 | 2.20 |
| buy-and-hold | 131 | 1 / 2 | 0.69 | 2.79 | 2.20 |

NIGHT, same window: ma-crossover 132 emitted no intent at all over 115 candles (its slow average
needs 49 and never crossed), rsi 133 returned -0.37%, buy-and-hold 134 returned -7.07%.

**This is a plumbing check, not a strategy result.** One day of data, three fills, and a series
spliced across two pools. What it establishes is that the observed-reserve path — deepest pool per
tick, reserves read from the snapshot, fill at t+1 against those reserves, per-venue costs — executes
end to end on real data and produces numbers a person can trace back to a row.

The 200-minute gap is the interval between the exploratory tick of 2026-09-06 20:50 and the start of
the M1 run at 2026-09-07 00:10, not a collection failure. The 20- and 30-minute gaps are the two
collector restarts of that night.

## What this changes

- The seven-day run's token choice should come from the movement table above, not from habit.
- Any run whose report carries the multi-pool warning has an equity curve that is not one pool's
  history, and its fees are not one venue's fees.
- `RUNBOOK-7day-run.md`'s precondition "real candles exist and one observed-reserve backtest has been
  read" is now met; runs 129 to 136 are that reading.
