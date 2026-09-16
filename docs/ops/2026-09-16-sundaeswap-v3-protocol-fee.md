# SundaeSwap V3 charges 1.28 ADA per order, across every pool sampled

Date: 2026-09-16
Venue: SundaeSwapV3 (order script `fa6a58bbe2d0ff05534431c8e2f0ef2cbdc1602a8456e4b13c8f3077`)

## Why this was checked

`VENUE_COSTS.SundaeSwapV3` carried 1.28 ADA at `basis: 'documented'`, and its own source string
admitted the documentation says something else: SundaeV3.pdf §4.4.3 documents a 0.5-1.0 ADA range
that the library does not follow. The number came from Dexter writing `protocolFeeDefault =
1280000n`, corroborated by one live quote in the M6.1 spike. That is the same reasoning MinswapV2
outgrew on 2026-09-16 ([the note](2026-09-16-minswap-v2-batcher-fee.md)), where the documentation
turned out to be wrong about the chain. So the same question applies here: what do live orders pay?

## One difference from Minswap, and it matters

Minswap V2's batcher fee is a constant Dexter writes. SundaeSwap V3's protocol fee is a **per-pool
datum value**: `sundaeswap-v3.js:77` reads `parameters.ProtocolFee` from the pool and only falls
back to `protocolFeeDefault` when the pool does not state one. A single pool's fee therefore proves
nothing about the venue, so the sample below deliberately spans several pools.

## Method

Identical to the Minswap note, with two substitutions: the credential above, and the fee is
**top-level field 2** of the order datum, not field 7. Field 2 comes from Dexter's
`definitions/sundaeswap-v3/order.js`, and the datum shape corroborates it — six top-level entries,
exactly one bare `int`, at position 2.

## Result, observed 2026-09-16 near block 13,949,195

| order tx | value (ADA) | pool id | field 2 (lovelace) | ADA |
|---|---:|---|---:|---:|
| `53479ec4d54cdd71…` | 568.911566 | `6f79e3e55eef82b9…` | **1,280,000** | **1.28** |
| `796b607034401681…` | 366.668928 | `64f35d26b237ad58…` | **1,280,000** | **1.28** |
| `396798dcc2ce0a3b…` | 321.919694 | `6f79e3e55eef82b9…` | **1,280,000** | **1.28** |
| `e5613f8c487dfef4…` | 292.817904 | `6f79e3e55eef82b9…` | **1,280,000** | **1.28** |
| `5f6f4fc21f2dfddb…` | 114.000000 | `bdf5e1ccc9aea3c8…` | **1,280,000** | **1.28** |
| `7c0ad11b2473ea60…` | 3.280000 | `5b5d1f9da977498b…` | **1,280,000** | **1.28** |

**6 of 6 orders, across 4 distinct pools, carry 1,280,000 lovelace.**
These are other people's orders.

The second row is the cleanest corroboration available: an order whose entire ADA content is
**3.28** — that is 1.28 protocol fee plus the 2 ADA deposit Dexter marks `isReturned: true`, and
nothing else, because the swap input is a token rather than ADA. The arithmetic of a stranger's
order reproduces `protocolFeeDefault + deposit.value` exactly.

## Verdict

**The number was already right: 1,280,000 lovelace, unchanged.** What changes is the grade, from
`documented` to `measured`. `documented` was the wrong word for a figure the documentation
contradicts; `measured` is what it actually is. Because both grades are excluded from the report's
assumed-costs warning, **no report output changes**.

## What this does not settle

- **The fee is per pool.** Four pools agreed. A pool created tomorrow could state a different
  `ProtocolFee`, and nothing here would notice. Before trading a SundaeSwap V3 pool for real,
  read that pool's own parameter rather than trusting this venue-level figure.
- **Sample and window.** Six orders near one block height. Re-run before any cost-model change.
- **Whether the 1.28 is consumed.** Inferred from `isReturned: false` and the 3.28 arithmetic, not
  proven from a fulfilment transaction.
- **The remaining `assumed` venues** — WingRiders, WingRidersV2, VyFinance, Splash — are still 2 ADA
  on no evidence at all, and are the obvious next targets for this method.

Transactions, for re-checking: 53479ec4, 796b6070, 396798dc, e5613f8c, 5f6f4fc2, 7c0ad11b.
