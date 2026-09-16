# The remaining four venues, measured: one of them may be understated

Date: 2026-09-16
Venues: Splash, WingRiders, WingRidersV2, VyFinance — the four entries still at `basis: 'assumed'`,
all charged 2 ADA on no evidence. Method as in the [Minswap](2026-09-16-minswap-v2-batcher-fee.md)
and [SundaeSwap](2026-09-16-sundaeswap-v3-protocol-fee.md) notes, adapted per venue.

**No value and no grade changed in this note's PR.** One venue needs a founder decision; two cannot
be graded on this evidence; one could not be measured at all.

## Why the method had to change per venue

The first two venues put their fee in the order datum, where a validator enforces it. These four do
not all do that:

| venue | where the fee lives | measurable this way? |
|---|---|---|
| Splash | order datum, **two** int fields | yes, directly |
| WingRiders | not in the datum; paid as attached ADA | only as a total |
| WingRidersV2 | not in the datum; paid as attached ADA | only as a total |
| VyFinance | not in the datum, and the order address is **per pool** | no |

Where the fee is not in the datum, the evidence available is a **token-input order**: one whose swap
input is a token, so the ADA attached to it is exactly fee plus returned deposit and nothing else.
That measures the TOTAL. It does not prove the split between the two.

## Splash — the finding that matters

Twenty-five order datums decoded, near block 13,949,195. The datum carries **two** fee fields, and
both are unanimous:

| field | name (Dexter definition) | value | ADA |
|---|---|---:|---:|
| 4 | `BaseFee` | 1,000,000 | **1.00** |
| 8 | `ExecutionFee` | 2,000,000 | **2.00** |

25 of 25 orders carry `1.00 + 2.00`. `VENUE_COSTS.Splash` models **2 ADA**.

Field 8 is confirmed as `ExecutionFee` by exact structural alignment: the live datum matches Dexter's
definition field for field across all eleven it defines (`Action`, `Beacon`, constructor,
`SwapInAmount`, `BaseFee`, `MinReceive`, constructor, constructor, `ExecutionFee`, constructor,
`SenderPubKeyHash`), with one extra trailing field the definition predates.

**If both fees are consumed, the model understates Splash by 1 ADA** — the direction that flatters
every result, and the one Principle I exists to catch. Supporting but not conclusive: Splash
token-input orders cluster at 4.50 ADA. Decomposed as 3.00 fee + 1.50 min-ADA that is an ordinary
single-token min-ADA; decomposed as 2.00 fee + 2.50 min-ADA it is high for one token.

**Not resolved here.** Whether `BaseFee` is additive to `ExecutionFee`, a floor within it, or
refunded, is a question about what the executor actually takes, and the only honest way to answer it
is to read a fulfilment transaction's outputs and see what leaves the order UTxO. Until then the
value stays at 2 ADA with this note attached, because changing it either way is re-parameterising the
cost model. **This is the one item here that needs a founder decision.**

## WingRiders and WingRidersV2 — total corroborated, split not proven

Order addresses `addr1wxr2a8htmzuhj39y2gq7ftkpxv98y2g67tg8zezthgq4jkg0a4ul4` (V1) and
`addr1w8qnfkpe5e99m7umz4vxnmelxs5qw5dxytmfjk964rla98q605wte` (V2). Neither order datum has a fee
field, so only the attached total is observable.

| venue | token-input orders | attaching exactly 4.00 ADA | Dexter predicts |
|---|---:|---:|---|
| WingRiders | 21 | **17** | agentFee 2.00 + oil 2.00 (returned) = 4.00 |
| WingRidersV2 | 38 | **31** | agentFee 2.00 + oil 2.00 (returned) = 4.00 |

The modal total is exactly what Dexter's model predicts, for both versions. The remainder sit at
4.50, 5.68 and 6.00, consistent with orders needing more min-ADA.

**This does not earn `measured`.** A 4.00 total is equally consistent with a 1.50 fee and a 2.50
deposit. What is corroborated is that Dexter's *total* is right, which is worth recording and is
better than the nothing these entries had. Both stay `assumed` at 2 ADA, with the corroboration in
their source. Grading them would need WingRiders' own documentation of the split, or a fulfilment
read.

## VyFinance — not measured, and a discrepancy worth knowing

VyFinance builds each order to `liquidityPool.marketOrderAddress`, a **per-pool** address, so there
is no single credential to sample. Its order datum holds only sender, action and minimum receive —
no fee. Measuring it means enumerating pools first; not attempted here.

Separately, and independent of the chain: **Dexter models VyFinance at 1.90 ADA** (`processFee`
1,900,000n plus a returned 2 ADA min-ADA), while `VENUE_COSTS.VyFinance` says 2.00. The table is
0.10 ADA higher than what our own submission path would write. That is the conservative direction,
so nothing is broken, but the two disagree and neither is measured. Recorded, not changed.

## Where the cost table now stands

| venue | ADA | grade | rests on |
|---|---:|---|---|
| Minswap | 0.00 | documented | venue docs |
| MinswapV2 | 2.00 | **measured** | 4 live order datums |
| SundaeSwapV1 | 2.50 | documented | SundaeV3.pdf §3 |
| SundaeSwapV3 | 1.28 | **measured** | 6 order datums, 4 pools |
| MuesliSwap | 0.95 | documented | venue docs |
| Splash | 2.00 | assumed | **possibly 3.00 — open** |
| WingRiders | 2.00 | assumed | total corroborated, split unproven |
| WingRidersV2 | 2.00 | assumed | total corroborated, split unproven |
| VyFinance | 2.00 | assumed | unmeasured; Dexter says 1.90 |

Two of nine now rest on the chain. The one that changed the picture is the one nobody asked about.
