# Cross-pair collection

Date: 2026-09-09. **Design only — nothing is built.** Successor to a finding, not to a milestone.

## 1. Why this exists

The founder's goal is to **stack ADA and NIGHT**. Two measurements from 2026-09-09 reshape what that
takes.

**NIGHT cannot be traded against ADA.** `docs/ops/2026-09-09-token-choice-ada.md`: NIGHT/ADA clears
the 216 bps round-trip floor in **9.5%** of 2 h windows — *below* USDA's 10.9%, i.e. NIGHT tracks ADA
more tightly than the dollar does. Accumulating NIGHT is an allocation decision, not a strategy.

**But there is a direct pool.** GeckoTerminal, MinswapV2, 2026-09-09:

| pool | reserve (USD) |
|---|---|
| NIGHT / ADA | 1,025,883 |
| **NIGHT / SNEK** | **280,426** |
| **NIGHT / USDCx** | **211,968** |
| SNEK / ADA | 838,798 |
| SNEK / USDCx | 77,852 |

Converting trading proceeds from SNEK into NIGHT is **one swap** through NIGHT/SNEK, or **two**
through ADA. At the measured 108 bps one way that is 108 bps against 216 — a halving of the cost of
precisely the operation the goal requires.

**We cannot see any of it.** `poolToSnapshot` throws `not an ADA pair` on anything that is not
token/lovelace, and `pool_snapshots.quote_unit` carries `CHECK (quote_unit = 'lovelace')`. Every
cross pair is invisible to the collector, the candles, and every backtest.

## 2. What must be true before this is built

1. **The 7-day run is untouched.** Three paper runs read `candles` continuously until ~16 September.
   Nothing in this design may alter that table, its key, or its writers. §4 is how that is honoured.
2. **The budget still fits.** §7. If a day is projected past the ceiling, cross pairs are dropped
   before the ADA pairs are.
3. **Nothing here assumes the direct route wins.** §8 is a measurement designed to be capable of
   saying it does not.

## 3. Scope: observation, not execution

**In scope.** Discover, refresh, snapshot and candle a named list of non-ADA pools, so the cost of a
direct route can be *measured*.

**Explicitly out of scope, and it is the larger half.** Trading on them. `cashAda`,
`run_equity.cash_lovelace`, the fill model and the 2.16% floor are all ADA-denominated; a NIGHT/SNEK
trade has no ADA leg at all. That is a rewrite of the accounting model and belongs to M6 — and is
worth doing only if §8 says the direct route wins.

This document deliberately stops at the point where the measurement exists.

## 4. Where ADA is wired in, and why this goes PARALLEL

| # | Site | What a cross pair breaks |
|---|---|---|
| 1 | `pool_snapshots.quote_unit` | `CHECK (quote_unit = 'lovelace')` rejects the row |
| 2 | `candles` PK `(base_unit, tick_ts)` | NIGHT/ADA and NIGHT/SNEK **collide** at the same tick |
| 3 | `priceAdaPerToken` | divides by `LOVELACE_PER_ADA`; a NIGHT/SNEK price is not ADA |
| 4 | `adaReserveOf`, `tvl_lovelace`, `COLLECT_MIN_DEPTH_ADA` | rank and filter by the ADA side, which does not exist |
| 5 | universe `Pair{base, quote:'lovelace'}` | discovery asks only for ADA pairs |
| 6 | engine, executor, cost model | out of scope by §3 |

**The decision: new tables, not a widened `candles`.**

Widening means changing the primary key of the table three live paper runs read. That is the class
of change that corrupts a week silently. A parallel path touches nothing they read, which is what
makes this safe to build **during** the run rather than after it.

It is also the honest modelling. A cross pair has no ADA leg, no ADA-denominated depth, and is not
comparable to an ADA-denominated cost floor. Forcing it into a table whose every invariant assumes
ADA is how `tvl_lovelace` ends up holding something that is not lovelace.

## 5. Schema

New migration. `candles`, `pool_snapshots` and `candles_external` are **not** altered.

```
cross_pair_snapshots (
  run_id, tick_ts, dex, pool_id, pool_address,
  base_unit, quote_unit,          -- neither is necessarily 'lovelace'
  reserve_base, reserve_quote,
  fee_bps, pool_type,
  block_height, observed_at,
  PRIMARY KEY (pool_id, tick_ts)
)

cross_candles (
  base_unit, quote_unit, tick_ts, pool_id,
  open, high, low, close,         -- QUOTE per BASE, both decimal-aware
  close_reserve_base, close_reserve_quote, fee_bps, pool_type,
  PRIMARY KEY (base_unit, quote_unit, tick_ts)
)
```

`quote_unit` is in the candle key — the omission that makes site 2 a collision. There is deliberately
**no `tvl_lovelace`**: depth in a pool with no ADA side is not lovelace, and a column named for a unit
it does not hold is the defect this project keeps finding.

## 6. Discovery and the tick loop

`FetchRequest.forTokenPairs(tokenPairs: Array<Token[]>)` accepts **any two differing tokens** — only
our own wrapper narrows it to `['lovelace', Asset]`. So Dexter needs no change; `DexterPoolSource`
does.

- A new `COLLECT_CROSS_PAIRS` env var names them explicitly: `NIGHT/SNEK,NIGHT/USDCx`. **An explicit
  list, never "all pairs of the universe"** — 20 tokens is 190 pairs, which is a budget bomb and
  mostly dust pools.
- Cross pairs are refreshed on the **full tick only**, never the focus tick. The focus interval exists
  to give the traded token a real high and low; a cross pair is being priced, not traded.
- Fails closed, matching `COLLECT_FOCUS_TICKER`: a pair naming a ticker outside the universe throws at
  startup rather than collecting nothing and looking healthy.
- A price needs both sides' decimals: `priceQuotePerBase(reserveQuote, reserveBase, baseDecimals,
  quoteDecimals)`, alongside `priceAdaPerToken` rather than replacing it. ADA is not special-cased
  as 6 decimals by accident — it is passed like any other quote.

## 7. Budget

Measured 2026-09-09: ~14.85 provider calls per pool per full tick; 96 full ticks a day; the day
projects to ~39,240 calls = **78% of the 50,000 tier**, ceiling 45,000.

Two cross pairs: `96 x 2 x 14.85` = **2,880/day, +5.8%** — landing near **84%**. It fits, and it is
not free. Three consequences:

- Cross pairs are the **first thing dropped** when a day is projected over the ceiling. They are a
  measurement; the ADA pairs are the product.
- Adding a third pair should be a decision, not a default.
- `checkQuotaSpend` already warns at 80% of the ceiling. At 84% it would warn daily, so that
  threshold wants re-expressing against the 50,000 tier before this lands, or the warning becomes
  noise and gets ignored.

## 8. How this is verified

Not "rows appear". The test is the question that motivated it:

> Over a week of collection, is the realised cost of **SNEK -> NIGHT direct** lower than
> **SNEK -> ADA -> NIGHT**?

Direct saves one fixed batcher fee (~2.2 ADA) and one spread, and pays higher price impact: NIGHT/SNEK
holds ~27% of NIGHT/ADA's reserve, so impact per unit size is roughly 3x. **The crossover is a
function of trade size and has not been measured** — that is the point of collecting.

The comparison is computable from the two candle series plus the existing cost table, at several
trade sizes. It must be capable of returning *"direct is worse"*; if it does, this thread closes and
the tables are dropped.

A second, cheaper check falls out of the same data: the implied ADA/USD dispersion across pools was
**median 12 bps, p90 36 bps** on 170 hourly ticks, against a 216 bps floor. Cross-pair rows extend
that measurement to routes that do not touch ADA.

## 9. What this does not claim

That the direct route is cheaper. That NIGHT should be accumulated by trading. That anything here
clears the cost floor — **nothing measured so far does**: NIGHT at 9.5%, arbitrage dispersion at 12
bps median, and `opportunity` on 2026-09-09 reading 0.0% of 48 SNEK candles clearing the floor
intra-candle.

It also does not address the deeper doubt: our collector samples reserves on a clock, while the pool
trades roughly once every 84 minutes, so a burst that round-trips between samples is invisible.
Cross-pair collection inherits that limitation exactly.

## 10. Open decisions the founder owns

1. **What the measurement is for.** A one-off answer to "is direct cheaper?" needs a few days of
   collection and no strategy machinery. Routing accumulation through cross pairs on an ongoing basis
   needs §3's out-of-scope half.
2. **Whether NIGHT accumulation is scheduled or opportunistic.** A calendar rule needs no edge and no
   cost floor beyond the one-way fee. An opportunistic rule is a market-timing bet and needs a signal
   nothing has yet produced.
3. **The role of stablecoins.** Holding them cannot hedge a portfolio denominated in ADA — ADA has no
   volatility against itself. As *dry powder* they are coherent but directional. As arbitrage they are
   priced out: USDA and USDCx never diverged past the floor in 279 hourly observations (max 103 bps).
