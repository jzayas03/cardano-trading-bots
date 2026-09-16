# The cost floor is a distribution, and 216 bps is the optimistic end of it

Date: 2026-09-16. First real run of `npm run cost-floor` (specs/002-cost-floor-distribution, T033).
Figures are **modelled, not realised** — see the limits at the end before quoting any of them.

## What was run

21,178 `pool_snapshots` rows from 2026-09-06T20:50Z to 2026-09-16T20:35Z, across 102 pools, priced
through the CPMM curve at five order sizes. 380 (pool, size) cells, of which **140 reached the
30-observation bar**.

Run against an exact export of the VPS table rather than on the box: the command is not deployed
there, and deploying mid-measurement-week is a founder decision that this did not need. The query is
the one `SNAPSHOT_SQL` runs, the code is the merged code, and no credential left the host.

| venue | sufficient / cells | basis |
|---|---|---|
| MinswapV2 | **100 / 100** | measured |
| SundaeSwapV1 | 25 / 105 | documented |
| SundaeSwapV3 | 15 / 45 | measured |
| Minswap | 0 / 70 | documented |
| MuesliSwap | 0 / 60 | documented |
| WingRiders, WingRidersV2 | excluded (D1) | assumed |
| VyFinance, Splash, synthetic, Fake | excluded (D1), no snapshots | — |

## The finding that matters

**Cost falls as order size rises, and the prediction written in advance had it backwards.**

MinswapV2, p90 across its 20 pools:

| size | min | median | max |
|---|---|---|---|
| 100 ADA | 500.6 | **595.0** | 19,575 |
| 250 ADA | 237.6 | **338.4** | 19,816 |
| 500 ADA | 151.1 | **262.8** | 19,908 |
| 1,000 ADA | 110.2 | **243.5** | 19,954 |
| 2,500 ADA | 93.2 | **256.1** | 19,982 |

`research.md` R9 predicted "p90 above 216 bps at 2,500 ADA on thin pools and possibly below it at
100 ADA on deep ones". **That is the wrong way round.** 100 ADA is the *worst* size and 1,000-2,500
the best, because the fixed venue fee dominates a small order: 2 ADA batcher + 0.2 ADA network, paid
on both legs, is 4.4 ADA — **440 bps of a 100 ADA round trip and 17.6 bps of a 2,500 ADA one.** Own
price impact only starts to win the argument back above ~1,000 ADA, which is why the median turns up
again at 2,500.

The prediction existed so this would be caught rather than rationalised. It was wrong about the
direction and right about the reason for having it.

**113 of the 140 sufficient routes have a p90 at or above 216 bps.** Only 27 are cheaper.

## Against the 216 bps figure

216 bps comes from one fill: run 139, 990 ADA into NIGHT on MinswapV2, 2026-09-08. The nearest
comparable cell here — MinswapV2, 1,000 ADA — has a **median p90 of 243.5 bps across 20 pools over
ten days**, with a range of 110.2 to 19,954.

So 216 is not wrong. It is one draw, and it sits below the middle of the distribution it was drawn
from. §2.1 called it the optimistic reading; that now has a number attached.

## Corroboration against the 41 real fills

Every filled MinswapV2 order in the project's history, priced through the same curve code at its own
notional against the reserves recorded at its fill tick.

| | modelled one-way | stored `slippage_bps` |
|---|---|---|
| median | 102.5 bps | 104.0 bps |
| range | 32.2 - 106.2 | 5.0 - 205.0 |

Modelled is at or below stored slippage in **28 of 41** fills, which is the direction T035 required:
slippage measures the fill against the decision-time mid, so it also contains whatever the price did
between t and t+1, which a same-tick quote cannot contain. The 13 exceptions are fills where the
price moved *favourably* in that gap.

The sharpest single check is run 139's own fill:

```
buy  990.0 ADA   modelled one-way 34.30   stored slippage_bps 86   stored price_impact_bps 34
```

**The model reproduces that fill's stored `price_impact_bps` to within 0.3 bps.** That is the
like-for-like comparison — both are fill-against-pool-mid and both are fee-inclusive — and it is the
strongest evidence here that the curve maths is right.

This is a sanity check, not a validation. 41 observations across 3 pools cannot validate a model;
they can catch a sign error, a units error or a factor of two, and they did not find one.

## Second run, with the depth filter (same day)

The dust problem below was fixed by reusing the project's existing `COLLECT_MULTI_VENUE_MIN_DEPTH_ADA`
(50,000 ADA a side) rather than inventing a threshold. Its own justification is the one that applies
here: "a spread against a pool nobody can trade is not an opportunity."

| | before | after |
|---|---|---|
| sufficient routes | 140 | 100 |
| **max p90** | **19,981.6 bps** | **1,045.3 bps** |
| pools reported as too thin | — | 53 |

The fiction is gone, and the 53 dropped pools are listed rather than vanishing — a pool dropped for
depth has not been judged expensive, it has not been judged at all, and those are different facts.

**MinswapV2 p90 across 18 pools, after filtering:**

| size | min | median | max |
|---|---|---|---|
| 100 ADA | 500.6 | **590.9** | 1,045.3 |
| 250 ADA | 237.6 | 328.3 | 789.2 |
| 500 ADA | 151.1 | 254.1 | 714.4 |
| **1,000 ADA** | 110.2 | **216.3** | 696.7 |
| 2,500 ADA | 93.2 | 251.5 | 834.8 |

### 216 bps is not the floor. It is the floor's minimum.

The median p90 at 1,000 ADA is **216.3 bps**. The constitution says 216. Run 139, the single fill
that produced that number, was **990 ADA**. Once the dust is removed, the measured median at that
size lands within 0.3 bps of the figure derived from one observation.

That is a much better result for the existing number than the first run suggested, and it sharpens
what is actually wrong with it. 216 is not optimistic **for the size it was measured at**. It is
close to exact there. What is wrong is treating it as **size-independent**:

- at 100 ADA the real median is **590.9 bps** — 2.7x the stated floor
- at 1,000 ADA it is 216.3 — the stated floor, and the cheapest size
- at 2,500 it rises again to 251.5 as own impact starts to outweigh the fixed fee

The curve is U-shaped and its minimum sits near 1,000 ADA, where the 4.4 ADA of fixed fees has been
amortised but price impact has not yet taken over. **216 bps is the best case, achievable only at
the right size on a deep pool** — not a floor that holds across sizes.

Surviving venues after filtering: MinswapV2 90 routes, SundaeSwapV1 5, SundaeSwapV3 5.

## Two problems this run exposed

**1. Dust pools produce fiction, and the report showed it as a number.** FIXED the same day; see the second run above. Ten sufficient routes have
a median TVL under 1,000 ADA, and the worst quotes **19,982 bps**. One pool has a median TVL of 9
lovelace. Constitution Principle III is explicit that a quoted price on a pool that thin is not a
market. The report carries TVL beside every figure so the reader can see it, but it does not filter,
and a p90 of 19,982 bps is not a cost — it is an artefact. A depth floor is the obvious next step
and is not in this feature's scope.

**2. FR-017 had a hole, found by this run and fixed in the same PR.** Venues excluded by policy were
only listed if they happened to have snapshots. VyFinance and Splash have none, so they vanished
from the report entirely and a reader would have concluded the exclusion policy did not touch them.
All six policy venues are now listed, with `no-snapshots` distinguishing "excluded and absent" from
"excluded and costly".

## An open question for the founder

**D1 says venues whose cost cannot be measured are excluded. Does `documented` count as measured?**

The decision as written removes the four `assumed` venues and says it leaves "MinswapV2 and
SundaeSwapV3 as the measured venues". But the implementation admits any venue with a cost entry, so
**SundaeSwapV1, Minswap and MuesliSwap survive on a `documented` basis** — a vendor's claim, not a
reading of the chain. SundaeSwapV1 contributes 25 of the 140 sufficient routes.

The repository already has a case where documentation and chain disagreed outright: Minswap's docs
said batcher fees were removed in May 2025 while every sampled V2 order paid 2 ADA. Treating
`documented` as good enough is the assumption that episode argues against.

This needs deciding before any figure here is used as a gate.

## Limits, stated plainly

- **Modelled, not realised.** No batcher latency, no submit-to-execute price move, no partial fills, no expiry, no adverse selection against a visible order. Realised cost first becomes measurable at the first funded trade.
- **The sell leg is assumed symmetric to the buy leg**, at the same notional against the same reserves. The real sell happens at a different time and size. This is the same assumption §2.1 makes by doubling.
- **No depth filter**, so thin-pool figures are present and wrong.
- **Basis grades are today's**, read from the live cost table, not what was known when each snapshot was taken.
- **Nothing in the cost model changed.** These are observations and a recommendation; raising the floor is a founder decision under Principle I.
