# More instruments, not a lower bar — and SNEK is the twelfth-cheapest of eighteen

Date: 2026-09-16. Founder decision: **`MIN_ROUND_TRIPS` stays at 30.** The lever is the one
`promotion.ts` already names — *"the lever for a promotable answer is more instruments in parallel,
not a longer wait on one"* — rather than relaxing the gate's sample size.

> **SUPERSEDED 2026-09-17 on the sample-size half, specs/003.** The gate no longer counts round
> trips at all: it asks whether a resampled interval on their mean excludes zero, so the bar is now
> a function of the evidence rather than a constant. That is not the relaxation this note refused —
> thirty mediocre round trips PASS the old count and FAIL the new check.
>
> **The instrument half of this note stands unchanged, and matters more than it did.** The existing
> `bootstrap.ts` had already measured that at n = 30 on heavy tails no bootstrap flavour reaches its
> nominal 95% — 83-93%, and 79.4% once returns are correlated — and concluded *"the constraint is
> the trade count, not the estimator."* So replacing the count did not buy more evidence. More
> instruments still does, which is exactly what this note argued.

This works out what that costs and what it buys.

## It needs no code

`packages/cli/src/liveFeed.ts:59` calls `buildCandlesForToken` on every tick of a paper run, so a
run started on a new token builds that token's candles as it goes. Internal candles exist only for
SNEK today because SNEK is the only token a paper run has ever been pointed at — not because the
pipeline is scoped to it. Snapshots are already multi-token: in the last 24 hours the collector wrote
279 for SNEK, 101 for HOSKY, 100 for AGIX, 99 for LQ, 98 each for NIGHT and SHEN.

**Starting a paper unit on a second token is an ops change, not a code change.**

## Which instruments, measured rather than chosen

Best round-trip cost at 500 ADA — the smallest order `MIN_BUY_LOVELACE` now allows — over pools
deeper than 50,000 ADA on measured venues, from ~21,000 snapshots:

| token | best p90 | depth (ADA) | |
|---|---|---|---|
| MIN | **151.1** | 6,438,617 | |
| NIGHT | **152.3** | 4,716,215 | |
| USDA | 154.0 | 3,420,825 | stablecoin |
| WMTX | **174.0** | 772,146 | |
| SHEN | 183.0 | 577,711 | reserve coin |
| INDY | **193.4** | 453,188 | |
| HOSKY | **206.7** | 1,063,877 | |
| STUFF | **227.9** | 1,010,586 | |
| USDM | 242.7 | 4,335,264 | stablecoin |
| FLDT | 254.1 | 3,305,084 | |
| IAG | 262.8 | 820,875 | |
| **SNEK** | **293.3** | 3,764,899 | **what every paper week has run on** |
| STRIKE | 295.7 | 2,599,335 | |
| ASCEND | 300.5 | 1,755,672 | |
| AGIX | 304.2 | 128,735 | |
| NVL | 305.7 | 1,113,129 | |
| LQ | 308.4 | 1,018,654 | |
| USDCx | 714.4 | 829,900 | stablecoin |

**SNEK is twelfth of eighteen.** MIN and NIGHT cost roughly **half** what SNEK costs to round-trip —
about 142 bps per cycle of pure handicap, paid on every trade of every paper week so far. Nothing
chose SNEK for its cost; it was chosen before any of this was measured.

**Stablecoins are excluded despite being cheap.** USDA, USDM, USDCx and SHEN price near a peg, so
there is almost nothing to capture. Low cost is half the question and this note only answers that
half — the other half needs internal candles these tokens do not have yet, which running them is
precisely how to get.

## What the box allows, and it is less than four

Measured on the VPS: **~118 MB resident per paper process**, collector ~158 MB, **855 MB available**
with the current four runs going.

| configuration | processes | approx RSS | verdict |
|---|---|---|---|
| today: 4 strategies x 1 token | 4 | ~470 MB | running |
| **+1 token, 4 strategies** | 8 | ~944 MB | **tight but feasible** |
| 4 tokens x 4 strategies | 16 | **~1.9 GB** | **impossible on 2 GB** |

The gate needs the candidate *and* both baselines on the **same** token — `beats-baselines` compares
within a token — so three processes per token is the floor and four is realistic.

So this box supports **two instruments, not four**. That takes the ~2-year problem to roughly one
year. Better, not solved.

**Four instruments needs either a bigger box or a code change** so one process runs several tokens.

> **Updated 2026-09-17: the box was SKIPPED, and "a few euro a month" was wrong.** The 4 GB CPX21 is
> about **$40/month**, not a few euro -- an unchecked figure that should not have been offered as a
> reason to buy anything. The founder declined it on 2026-09-17. Two further corrections to the
> arithmetic above: the ~118 MB per process is RSS, which counts the shared node binary once per
> process, and the real marginal cost is ~67 MB of `Private_Dirty`; and the npm and tsx wrappers
> removed in #170 and #171 took ~33 MB per run with them. Eight instances therefore fit the 2 GB box
> with ~600-700 MB spare rather than "tightly". Sixteen still does not fit, so the conclusion of this
> note stands: **two instruments**, and four needs the code change, not a purchase.

## Recommendation

1. **At the next cutover, add one token: NIGHT or MIN.** Both are about half SNEK's cost and both are deep. NIGHT has the stronger case — it has ADA-denominated external history (14,703 candles) to backtest against first, and the founder already holds a NIGHT-vs-ADA conviction, so the result will be read carefully either way.
2. **Keep SNEK running.** Dropping it forfeits the only internal-candle history the project has.
3. **Then decide on the box.** Two instruments halve the wait; four quarter it, and four does not fit in 2 GB.
4. **Do not start anything mid-week.** Runs 150-153 are live; this is a cutover change.

## What this does not claim

That MIN or NIGHT is more *profitable* than SNEK. It says they are **cheaper to trade**, measured,
and that cost is the half of the question that has been silently working against every result so far.
Whether their prices move enough is the other half, and running them is how that gets measured.
