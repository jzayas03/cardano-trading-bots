# The three `documented` venues, read off the chain. None of them survives it.

Date: 2026-09-16. Method: Koios, free, no Blockfrost quota — the recipe in
`docs/ops/2026-09-16-minswap-v2-batcher-fee.md`, with one addition below.

Run to settle a question the cost-floor work raised: **D1 excludes venues whose cost cannot be
measured. Does `documented` count as measured?** Three venues carry `basis: 'documented'` —
Minswap V1, SundaeSwapV1 and MuesliSwap — and between them they contributed 30 of the 140 sufficient
routes in the first cost-floor run.

## The addition to the method: collateral identifies the batcher

The first attempt reported Minswap V1 taking **835 ADA per order**, which is a swap's proceeds, not
a fee. The reconciliation identity held at zero, so the accounting was right and only the
attribution was wrong: "largest positive net" picks the **user**, who receives the ADA.

`tx_info.collateral_inputs` is the fix. A Plutus spend needs collateral, and the batcher is the only
party posting it. So:

```
batcher      = collateral_inputs[0].payment_addr.bech32
cost to user = net(batcher) + txFee          # the batcher pays the tx fee out of its take
```

Worth keeping: **in a fulfilment the fee-taker is the collateral provider, not the biggest gainer.**

## Minswap V1 — the model says 0. The chain says 2.

| | |
|---|---|
| fulfilments reconciled | **13 of 13**, identity exact in all |
| take per order | **2.000000 ADA** |
| variance | **none** — every one of the 13 is 2.000000 |

The batcher nets ~1.23 ADA and pays ~0.77 in tx fee; the sum is 2.000000 every time. Simple orders
lock 4.0 ADA (2 fee + 2 deposit) in the order UTxO.

`VENUE_COSTS.Minswap` is **`batcherFeeLovelace: 0n`**, and its comment explains why:

> The 0 here is what proves Dexter's constant is not a reading of current policy: Dexter writes the
> IDENTICAL 2 ADA for this venue, which documentation puts at zero.

The repo knew Dexter wrote 2 and modelled 0 anyway, because the documentation said 0. **This is the
MinswapV2 episode again, one entry away in the same file.** Constitution Principle I is the rule
that was not applied: the submission path is the authority, not the documentation.

**The model understates Minswap V1 by 2 ADA per order — the direction that flatters a strategy.**

## SundaeSwapV1 — the scooper's ADA take is exactly zero, and that does not mean free

| | |
|---|---|
| fulfilments reconciled | 5 of 5, identity exact |
| scooper net | **exactly 0.000000 in all five** |
| apparent "take" | 0.8157 - 0.8222 ADA, which is **purely the tx fee the scooper pays** |

This is SundaeSwapV3's pattern exactly: the fee never leaves as a separate output because it is
retained inside the pool and paid through a worse price. The model's 2.5 ADA is a documented
scooper fee that this method can neither confirm nor refute.

**Not measurable this way.** Recorded as such rather than as "measured at zero" — the rule from the
V3 note holds: a zero result means the fee did not leave as a separate output, not that the swap was
free.

## MuesliSwap — there is no flat fee to measure

| tx | orders | batcher net | tx fee | take/order |
|---|---|---|---|---|
| d3fc577757 | 2 | 0.000000 | 0.5176 | **0.2588** |
| 78a7f2625c | 1 | 0.5687 | 0.9313 | **1.500000** |
| 0db5a7a3c7 | 2 | 0.000000 | 0.5176 | **0.2588** |
| c0ef4b9d03 | 1 | 0.8107 | 0.6893 | **1.500000** |
| db2d9b774c | 1 | 2.4402 | 1.0255 | **3.4657** |
| 817a4e872f | 1 | **-1.0227** | 1.0276 | **0.0049** |
| 49e742b4f2 | 1 | 0.4003 | 0.7637 | **1.1640** |

A 700-fold range, and in one fulfilment the matchmaker **lost money** (net -1.02 ADA). Two
fulfilments land on exactly 1.500000, which looks like a real fee tier; the rest do not.

MuesliSwap is an order book rather than a pure AMM, so matchmaker economics vary per order. The
model's flat 0.95 ADA is not what any of these seven paid. This is the Splash shape: **a venue whose
cost varies per order cannot be expressed by a table keyed on the venue.**

## The answer to D1

**`documented` should not count as measured.** Not as a matter of principle — as a matter of these
three results:

| venue | modelled | chain says | |
|---|---|---|---|
| Minswap V1 | 0 ADA | **2.000000, 13/13** | understated by 2 ADA |
| SundaeSwapV1 | 2.5 ADA | scooper net **0 in 5/5** | unverifiable; fee retained in-pool |
| MuesliSwap | 0.95 ADA | **0.005 to 3.47** | not a flat fee at all |

Three for three, a documented figure failed to describe what the chain does. One was wrong in the
dangerous direction, one cannot be checked by this method, and one is not the right shape.

**Recommendation — all three excluded from the execution allowlist**, leaving MinswapV2 and
SundaeSwapV3. That removes 30 of the 140 sufficient routes from the first cost-floor run, 25 of them
SundaeSwapV1's.

## Stop and ask

Two changes follow from this and **neither is made here**. Lowering or re-parameterising the cost
model is a founder decision under Principle I, and raising it is still re-parameterising it.

1. **`VENUE_COSTS.Minswap` should go from 0 to 2,000,000 with `basis: 'measured'`**, citing this
   note. It is the same correction MinswapV2 got on 2026-09-16 and it moves the model against our
   own interest, which is the direction that needs no suspicion but still needs approval.
2. **SundaeSwapV1 and MuesliSwap should be re-graded from `documented` to `assumed`**, because the
   grade currently claims a confidence the chain does not support.

## Limits

Sample sizes are small: 13, 5 and 7 fulfilments from roughly the last 2,000 blocks. The Minswap
result is nonetheless strong — zero variance across 13 independent transactions, with the
reconciliation identity exact in every one. The other two are strong enough to refute a flat
figure, which is all they are being asked to do.
