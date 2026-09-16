# Splash takes 2 ADA plus about 1% of proceeds, and the cost model cannot express that

Date: 2026-09-16
Follow-up to [the remaining-four note](2026-09-16-remaining-four-venues.md), which found that a
Splash order datum declares TWO fees — `BaseFee` 1 ADA and `ExecutionFee` 2 ADA — against the 2 ADA
this repo models, and left the question open: what does the executor actually take?

Twelve fulfilment transactions were read to answer it. The answer is neither 2 nor 3.

## Method

A fulfilment is a transaction where the order script credential appears as an **input**. Koios
returns `inputs: []` unless `_inputs: true` is passed, which is why an earlier pass found none.

For each, every input and output was netted per payment credential. The identity
`sum(nets) = -networkFee` holds exactly in all twelve, so nothing is unaccounted for. The user is
identified by the sender key hash in datum field 10. "What the order cost" is then what the user
gave up above the pool's payout:

```
cost = (pool payout + ADA attached to the order) - (ADA the user received)
     = executor's net gain + the Cardano network fee
```

## Worked example, tx `3fd131c7a596…`

| | ADA |
|---|---:|
| pool paid out for the tokens | 422.021869 |
| plus ADA attached to the order | 5.000000 |
| **available to the user in a zero-fee world** | **427.021869** |
| user actually received | 420.185500 |
| **cost of the swap** | **6.836369** |
| of which Cardano network fee | 0.616151 |
| of which taken by a credential that contributed no input | 6.220218 |

The order's datum declared `BaseFee 1 + ExecutionFee 2 = 3`. The swap cost 6.84.

## Across ten token-to-ADA orders

| tx | user received | executor net | net minus 2 ADA | as % of proceeds |
|---|---:|---:|---:|---:|
| `303ad0f40e` | 165.71 | 3.6492 | 1.6492 | 0.995% |
| `a1ff5d368c` | 221.94 | 4.2172 | 2.2172 | 0.999% |
| `354413c9f1` | 363.48 | 5.6474 | 3.6474 | 1.003% |
| `8e6ed6799f` | 412.00 | 6.1370 | 4.1370 | 1.004% |
| `3fd131c7a5` | 420.19 | 6.2202 | 4.2202 | 1.004% |
| `1d21641e54` | 499.72 | 7.0236 | 5.0236 | 1.005% |
| `a2b006a418` | 555.36 | 7.5856 | 5.5856 | 1.006% |
| `4de36672b0` | 1,795.58 | 2.0000 | 0.0000 | 0.000% |
| `3db1c18f05` | 1,816.10 | 2.0000 | 0.0000 | 0.000% |
| `69625b1fc1` | 1,837.14 | 2.0000 | 0.0000 | 0.000% |

**Seven of ten: 2 ADA plus 1.00% of proceeds**, holding to within a hundredth of a percent across a
three-fold range of order sizes. That is not a coincidence and it is not slippage.

**Three of ten: exactly 2 ADA and nothing proportional** — and they are the three largest, all around
1,800 ADA, consecutive, plausibly one bot on one pool. **I cannot explain the split from twelve
transactions**, and this note does not pretend to. Candidates: a different pool type, a different
executor, or a fee taken on the token side rather than in ADA.

~~The 1% is not the pool's own fee: the same datums carry `LpFeeNumerator/Denominator` of 13/10000,
which is 0.13%...~~ **WITHDRAWN 2026-09-16, see the postscript.** That reading of datum field 7 was
wrong. What stands: the credential collecting the extra contributes no input to the transaction, so
it is not a pool.

Two further orders were ADA-to-token and are excluded: there the pool *gains* ADA, so "largest
positive net" identifies the pool rather than the executor. Measuring those needs the pool
credential known in advance.

## What this means for the cost model

**The problem is not that 2 is the wrong number. It is that no number is right.**
`VenueCosts` has `batcherFeeLovelace` and `networkFeeLovelace`, both fixed lovelace amounts. There is
no proportional term. A venue charging a percentage cannot be expressed at all, so on a 500 ADA
order Splash is modelled at 2 ADA and appears to cost about 7.

For scale: 1% per leg is roughly 200 bps on a round trip. SNEK's measured round-trip floor is 371
bps. A venue with a percentage fee would roughly double the floor for any strategy routed through
it, and nothing in the model or any report would show it.

**Nothing was changed.** Adding a proportional fee is a schema change to `VenueCosts` that touches
the fill model, `buildRunParams`, every persisted `runs.params.costs` blob and the reports. That is
a founder decision, not a drive-by.

## Urgency: low today, and worth knowing why

Splash is **not in the fill path**. Over the last seven days `pool_snapshots` holds zero Splash rows,
and across every paper run ever, `paper_orders` holds zero Splash fills:

| venue | snapshots, 7 days | fills, all runs |
|---|---:|---:|
| MinswapV2 | 14,688 | 41 |
| SundaeSwapV1 | 154 | 0 |
| WingRidersV2 | 98 | 1 |
| MuesliSwap | 84 | 0 |
| WingRiders | 77 | 0 |
| SundaeSwapV3 | 63 | 1 |
| **Splash** | **0** | **0** |
| **VyFinance** | **0** | **0** |

So no result to date is affected. The exposure is prospective: the depth filter picks the deepest
pool, and if a Splash pool ever wins for a token being traded, the model would understate that trade
by about 1% of notional with nothing flagging it — `basis: 'assumed'` warns that the number is a
guess, not that the *shape* of the formula is wrong.

## What would settle the rest

1. Read the three anomalous fulfilments in detail and find what distinguishes them.
2. Read the Splash contract or SDK for the executor fee formula, rather than inferring it.
3. Decide whether `VenueCosts` grows a proportional term, or whether Splash and VyFinance are
   excluded from the tradable venue set until one exists.


---

# Postscript: the split is the POOL, and one claim above is withdrawn

The three anomalies were read in full and compared field by field against a control.

## What distinguishes them: nothing in the order

The two order datums are **structurally identical and identical in every fee-bearing field**:
twelve fields each, `BaseFee` 1 ADA (field 4), `ExecutionFee` 2 ADA (field 8), and the same fee
collector in field 11. The order does not declare what is actually charged.

## What distinguishes them: the pool

Grouping all ten token-to-ADA fulfilments by the pool credential splits them perfectly:

| pool credential | tx | proceeds (ADA) | Splash took | % of proceeds |
|---|---|---:|---:|---:|
| `cb684a69e78907` | `303ad0f40e` | 165.71 | 3.6492 | 2.202% |
| `cb684a69e78907` | `a1ff5d368c` | 221.94 | 4.2172 | 1.900% |
| `cb684a69e78907` | `354413c9f1` | 363.48 | 5.6474 | 1.554% |
| `cb684a69e78907` | `8e6ed6799f` | 412.00 | 6.1370 | 1.490% |
| `cb684a69e78907` | `3fd131c7a5` | 420.19 | 6.2202 | 1.480% |
| `cb684a69e78907` | `1d21641e54` | 499.72 | 7.0236 | 1.406% |
| `cb684a69e78907` | `a2b006a418` | 555.36 | 7.5856 | 1.366% |
| `f002facfd69d51` | `4de36672b0` | 1,795.58 | 2.0000 | 0.111% |
| `f002facfd69d51` | `3db1c18f05` | 1,816.10 | 2.0000 | 0.110% |
| `f002facfd69d51` | `69625b1fc1` | 1,837.14 | 2.0000 | 0.109% |

Seven orders on pool `cb684a69`: **2 ADA plus 1.00% of proceeds**, fitting to within a hundredth of
a percent. Three orders on pool `f002facf`: **flat 2 ADA**. **The fee collector is the same
credential in every one of the ten.** So it is not a different executor, not a different order type
and not discretion — it is a property of the pool.

## Why this is worse than a missing percentage term

`VENUE_COSTS` is keyed by **venue**. This fee varies **within** a venue, by pool. So even adding a
proportional field would not be enough: two Splash pools charge different formulas, and a
venue-level entry cannot represent both. The cost model's key is wrong for this venue, not only its
shape.

The practical consequence for the depth filter: it selects the deepest pool for a token. On this
evidence the deepest pool is not necessarily the cheapest, and the difference is over a percent of
notional — far larger than any batcher fee this repo models.

## The withdrawn claim

The note above asserted that the same datums carry an LP fee of 13/10000, so 0.13%, and used that
to argue the 1% was not a pool fee. **That is withdrawn.** Field 7 is a pair of integers whose
meaning is not pinned down: in one sampled unspent order it read `(13, 10000)`, while in every
fulfilled order read here it equals `(minReceive, SwapInAmount)` — a duplicate of fields 5 and 3,
not a fee. Dexter's definition labels the position `LpFeeNumerator/Denominator`; the chain does not
agree, at least not uniformly.

The conclusion the claim was supporting does not depend on it. What supports it instead: the
credential collecting the extra ADA contributes **no input** to the transaction, and a pool always
does. It is a fee address, not a pool.

## Still open

- The actual formula. Ten orders on two pools show *that* it varies by pool, not *how* it is
  parameterised. That needs the Splash contract or SDK, not more samples.
- Whether other venues do this. WingRiders and VyFinance were never checked for per-pool fee
  variation, and the same question applies to them.
