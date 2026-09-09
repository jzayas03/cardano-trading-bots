# Choosing the token, in ADA

Date: 2026-09-09. **Supersedes `docs/ops/2026-09-08-token-choice.md`**, which measured the right
thing in the wrong currency.

## Correction, same day: the floor is not 216 bps for everybody

The table below ranked every token against a flat **216 bps**. That figure was calibrated on run
139's fill, and **run 139 traded NIGHT** — a pool charging 30 bps. Pool fees vary **3.3x** across
tokens we already collect (NIGHT/MIN/USDA/WMTX/AGIX 30, HOSKY 50, STUFF 60, IAG 75, FLDT 80,
SNEK/STRIKE/ASCEND 100, USDCx 300), and price impact varies with depth. Charging each token what it
actually costs changes the ranking and the conclusion.

**One-way cost = pool fee + impact(depth) + 22 bps spread + 22 bps batcher/network.** Impact is
scaled from the one measurement there is: 34 bps for a 990 ADA order against NIGHT's 2,359,348 ADA
side, and impact moves with size/depth. On NIGHT this reproduces the measured 216 bps exactly, which
is the only reason to trust it elsewhere.

| token | fee | ADA depth | impact | **its floor** | n | **2h % vs OWN floor** | 2h % vs flat 216 |
|---|---|---|---|---|---|---|---|
| ASCEND | 100 | 850,412 | 94 | 477 | 1111 | **11.9** | 40.5 |
| STRIKE | 100 | 1,307,542 | 61 | 411 | 907 | **11.6** | 35.6 |
| **NIGHT** | 30 | **2,359,348** | 34 | **216** | 2322 | **9.5** | 9.5 |
| *USDA* | 30 | 1,673,615 | 48 | 244 | 1393 | *8.3* | *10.9* |
| **SNEK** | 100 | 1,941,419 | 41 | **371** | 1152 | **6.8** | 27.6 |
| WMTX | 30 | 388,606 | 206 | 561 | 554 | 5.8 | 33.8 |
| STUFF | 60 | 505,719 | 159 | 525 | 414 | 5.6 | 15.7 |
| MIN | 30 | 3,195,534 | 25 | **198** | 782 | 3.1 | 2.3 |
| IAG | 75 | 412,123 | 195 | 627 | 570 | 1.9 | 27.2 |
| HOSKY | 50 | 542,485 | 148 | 484 | 213 | 1.4 | 13.1 |
| USDCx | 300 | 405,901 | 198 | 1083 | 625 | 1.4 | 28.2 |
| AGIX | 30 | 64,455 | 1245 | 2637 | 136 | 0.7 | 22.1 |

**Three things follow.**

**SNEK looks much worse: 27.6% -> 6.8%.** It moves more than most AND charges 100 bps, and net of its
own costs it sits below the noise floor. **This is not a reason to switch, because nothing else
clears either** — see below.

**A cheap fee does not rescue a thin pool.** WMTX was the obvious candidate on fee alone — 30 bps,
33.8% against a flat floor. Its pool is a fifth of SNEK's, so a 990 ADA order pays ~206 bps of impact
and its real floor is 561 bps: **5.8%, worse than SNEK.** The superseded 2026-09-08 doc had this
right and said so — *"ASCEND and STRIKE move more but sit on pools less than half SNEK's depth, and
our own price impact is charged against that depth."* Ranking on fee alone repeats the mistake this
correction exists to fix, one variable over.

**Nothing clears meaningfully.** The best is ASCEND at 11.9% against a stablecoin noise floor of
8.3%. That is inside noise, not an edge. **No token in this universe demonstrably clears its own cost
floor**, and the honest reading of this table is that the taker side of these pools is not where a
profit is.

**NIGHT has the LOWEST floor of any liquid token here (216 bps)** — deepest pool and cheapest fee
together — while moving least. That combination is bad for trading and is precisely what makes it
interesting on the *other* side of the fee: see `docs/specs/2026-09-09-cross-pair-collection.md` §1
and the liquidity-provision note below.

### The maker side, for scale

NIGHT/ADA turned over **~1.07M ADA/day** in the week to 2026-09-08 (3-month average 2.47M, so the
recent week is the conservative figure) through a pool holding ~4.72M ADA, at 30 bps. That is roughly
**3,200 ADA/day of fees to the pool**, ~0.068%/day, shared pro rata. The volatility that makes NIGHT
untradeable — 9.5%, median 2 h move 71 bps — is the same property that keeps impermanent loss small.

**Not a recommendation, and it cuts against the stated goal**: if NIGHT appreciates against ADA, an
LP position ends up holding *less* NIGHT than simply holding would. Fee income has to beat that, and
whether it does is a conviction about NIGHT, not a measurement. Recorded here because the cost
structure is measured and the arithmetic is not obvious.

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

## The table (flat 216 bps — see the Correction above before citing it)

% of contiguous windows whose absolute return exceeds 216 bps. **This flat floor is wrong for every
token whose pool does not charge 30 bps**; the corrected ranking is at the top of this document. `n` is 2-hour windows.

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
