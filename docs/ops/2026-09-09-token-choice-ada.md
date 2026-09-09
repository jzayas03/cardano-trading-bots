# Choosing the token, in ADA

Date: 2026-09-09. **Supersedes `docs/ops/2026-09-08-token-choice.md`**, which measured the right
thing in the wrong currency.

## The defect

That table ranked tokens by "% of windows whose absolute return exceeds 2.16%" over 54,050
GeckoTerminal candles. Those candles are **US dollars**. `geckoTerminal.ts` requested
`ohlcv/minute?aggregate=5` with no `currency` parameter and GeckoTerminal defaults to `usd`, so
three months of `candles_external` were dollar-denominated and nothing recorded it (#89, migration
0008).

The 2.16% floor is **ADA**: batcher and network fees are paid in ADA and the pool fee is charged
against ADA reserves. So the table asked *"does SNEK/USD move more than an ADA cost?"* — and the
pair we trade is SNEK/ADA.

Diagnosed by dividing the two series against each other on the same pool (SNEK/ADA MinswapV2,
`f5808c2c…`): the implied rate across 19 matched timestamps was 0.2145–0.2237, mean 0.2206,
relative stddev 122 bps. A near-constant multiplier is a currency rate, not a broken instrument.

## The method is unchanged, and that was checked first

Same hourly resampling, same contiguous-window rule, same 2h/6h/24h durations, same floor. Run
against the **USD** rows it reproduces the superseded table to within 0.2 points on every token —
SNEK 35.0 vs 35.1, NIGHT 10.3 vs 10.3, USDA 0.8 vs 0.8.

That matters: it means every difference below is attributable to the **denomination**, not to the
method quietly changing at the same time as the conclusion.

## The stablecoins are the measuring stick

A USD stablecoin priced against ADA **is** the ADA/USD rate. So the stables are not noise in this
table — they are a direct read of how much of every other token's USD figure was ADA moving.

| stablecoin | USD 2h | **ADA 2h** | rows | |
|---|---|---|---|---|
| USDA | 0.8% | **10.9%** | 7,189 | the usable proxy |
| USDCx | 17.4% | **28.2%** | 2,859 | thinner pool, noisier |
| USDM | — | — | **0** | no external data at all |

Both rose, which is the prediction the diagnosis makes and the cheapest independent confirmation
of it.

They disagree — 10.9 vs 28.2 — while measuring the same underlying quantity. USDCx has 40% of
USDA's rows on a thinner pool, so the excess is pool microstructure, not ADA/USD. **USDA is the
proxy to use.**

**USDM has never had external data in either denomination**: `external_pool_map` points it at
SaturnSwap, which serves no OHLCV. SONG is likewise absent — GeckoTerminal 404s on its token-pools
endpoint. Neither was lost in the ADA re-backfill; both were already missing, and the re-backfill
returned 19 of 20 tokens with slightly MORE rows than the USD pass (55,171 vs 54,118).

## The table

% of contiguous windows whose absolute return exceeds 216 bps. `n` is 2-hour windows.

| token | n | **2h** | 6h | 24h | 2h median bps | USD 2h was |
|---|---|---|---|---|---|---|
| INDY | 58 | 50.0 | 90.9 | — | 226 | 60.3 |
| SHEN | 82 | 46.3 | 84.6 | — | 198 | 57.3 |
| ASCEND | 1111 | **40.5** | 66.1 | 80.0 | 172 | 44.5 |
| STRIKE | 907 | **35.6** | 59.0 | 90.0 | 158 | 42.9 |
| WMTX | 554 | **33.8** | 66.3 | 81.3 | 136 | 38.4 |
| *USDCx* | *625* | *28.2* | *52.4* | *100.0* | *128* | *17.4* |
| **SNEK** | 1152 | **27.6** | 48.9 | 90.8 | 134 | 35.0 |
| IAG | 570 | **27.2** | 62.2 | — | 124 | 31.1 |
| AGIX | 136 | 22.1 | 49.1 | 50.0 | 117 | 30.1 |
| STUFF | 414 | 15.7 | 42.9 | — | 87 | 29.1 |
| HOSKY | 213 | 13.1 | 46.4 | — | 99 | 28.3 |
| *USDA* | *1393* | *10.9* | *34.8* | *72.4* | *73* | *0.8* |
| **NIGHT** | 2322 | **9.5** | 28.4 | 58.7 | 71 | 10.3 |
| MIN | 782 | 2.3 | 11.9 | 21.6 | 66 | 12.4 |
| FLDT | 60 | 1.7 | 0.0 | — | 82 | 30.0 |

INDY and SHEN lead on n=58 and n=82. **Too thin to rank** — they are listed, not ranked, for the
same reason the superseded table left them out.

## What it changes

**The instrument choice survives.** SNEK at 27.6% is still well clear of the ~11% floor and still
about 2.9x NIGHT (it was 3.4x in dollars). The confound cost SNEK 7 points and did not change the
decision. That is worth stating as plainly as a reversal would have been.

**Everything the old table ranked below ~15% was unranked, not ranked low.** MIN fell 12.4 -> 2.3
and FLDT 30.0 -> 1.7: their apparent volatility was almost entirely ADA's own. Below the stablecoin
floor there is no signal to order tokens by.

**NIGHT is quieter against ADA than the dollar is.** 9.5% against USDA's 10.9%. NIGHT tracks ADA
more tightly than USD does, so **there is no NIGHT/ADA trading edge to capture** — a strategy built
to round-trip NIGHT against the 2.16% floor would be trading noise at a guaranteed loss.

Given the stated goal of accumulating **both ADA and NIGHT**, that reframes NIGHT: it is an
allocation decision (when to convert ADA into it), not a trading instrument. That rule has not been
designed and is not in any milestone yet.

## What this still does not claim

That a strategy can capture any of these moves. Moves of sufficient size **existing** is a necessary
condition, not a sufficient one — the same caveat the superseded table carried, and it survives the
correction intact. The live week measures the sufficient half.

Two limits worth naming. These are **hourly close-to-close** windows on a **trade-derived** feed;
our own collector samples reserves on a clock and undersamples a pool that trades roughly once every
84 minutes (`opportunity` on 2026-09-09 read 0.0% of 48 candles clearing the floor intra-candle,
median 0 bps). And re-run this before choosing an instrument again — liquidity and volatility both
drift, which is why the superseded table said so too.

## Reproducing it

```
npm run backfill -- ALL 2026-06-01T00:00:00Z <now> --currency ada
```

then the query in this commit's PR body. Every read of `candles_external` must state its
denomination; `denominationPredicate.guard.test.ts` fails any that does not.
