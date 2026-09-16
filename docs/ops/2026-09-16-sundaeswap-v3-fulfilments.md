# SundaeSwap V3: the scooper takes no ADA, and that does NOT mean the swap is free

Date: 2026-09-16
Venue: SundaeSwapV3. Completes the set: [MinswapV2](2026-09-16-minswap-v2-does-not-vary-by-pool.md)
and [Splash](2026-09-16-splash-fulfilment-read.md) were reconciled; this was the last gap.

**Headline: this method cannot measure SundaeSwapV3, and the reason is worth more than the number.**

## What was measured

23 fulfilment transactions found, every one scooping exactly **one** order (no batching in this
sample, despite "scooping" being the venue's own term for batching). 22 reconciled.

| | result |
|---|---|
| declared protocol fee, every order | 1.28 ADA |
| scooper's ADA gain above the network fee | **exactly 0.000000, in 22 of 22** |

In every transaction the scooper's net is exactly minus the network fee: it pays the gas and takes
no ADA.

## Worked example, `ef7ce0a4cf40c3fa`

| credential | net ADA | what it is |
|---|---:|---|
| `636d0d0118a8` | +1,575.7703 | the user |
| `e0302560ced2` | −1,572.4903 | the pool, paying out |
| `fa6a58bbe2d0` | −3.2800 | the order script (1.28 fee + 2.00 deposit) |
| `4a7110f2c2ca` | −0.5918 | the scooper, paying exactly the network fee |

1,572.4903 + 3.2800 = 1,575.7703. **The user got the entire 3.28 back, including the 1.28 that the
datum declares as the protocol fee.**

## Why "cost = 0" is the wrong conclusion

The order genuinely paid a fee; this accounting just cannot see it. On Minswap the batcher's fee
leaves as a visible positive net. Here nothing leaves, which leaves two possibilities:

1. **The 1.28 is retained inside the pool** as accrued protocol revenue, so the pool simply pays out
   1.28 less than the pure formula would give. The user pays it through a worse price, which an
   ADA-flow reconciliation cannot distinguish from a better price. Scoopers would then claim the
   accrual separately. This is the likely one: a scooper systematically subsidising gas across 22 of
   22 transactions is not a business.
2. The fee is not charged at all — implausible, since the validator reads the field.

**The methodological rule this establishes:** a zero from this reconciliation means *the fee does not
leave as a separate output*, not *the fee is zero*. Anyone reading these notes later must not
conclude SundaeSwapV3 is free. The 1.28 stands on the datum evidence, measured across four pools,
which this does not touch.

## A Koios gotcha that cost a wrong reading

`tx_info` returns `asset_list: []` on **inputs**, even when the UTxO holds tokens. The order above
appears to hold no assets; `utxo_info` on the same reference shows it held **694,086,488 STRIKE**
alongside its 3.28 ADA. It was a token-to-ADA swap all along.

Every ADA reconciliation in these notes is unaffected — `value` (lovelace) is correct on inputs, and
only lovelace was used. But any future work needing token quantities must call `utxo_info` per
reference rather than trusting `tx_info.inputs`.

## What would settle it

Reconstruct the expected payout: take the pool's reserves before and after from `utxo_info`, apply
the constant-product formula with the pool's own LP fee, and compare to the 1,572.4903 actually
paid. If the shortfall is 1.28 ADA, possibility 1 is confirmed and the fee is real and correctly
modelled. That needs the token quantities the gotcha above hides, plus the pool's LP fee from its
datum — an hour, not a day.

**Not done here**, on grounds of proportion: SundaeSwapV3 carries **1 of 46** paper fills, and the
declared-fee measurement across four pools is unchanged either way.

## The set, complete

| venue | fills | declared | varies by pool? | what the fulfilment shows |
|---|---:|---|---|---|
| MinswapV2 | 41 | 2 ADA | no, 10 pools | **takes exactly 2.000000**, 28 of 28 |
| SundaeSwapV3 | 1 | 1.28 ADA | no, 4 pools | takes no ADA; fee likely retained in-pool, **unresolved** |
| Splash | 0 | 3 ADA | **yes** | **takes up to 7.6**, 2 ADA + ~1% on one pool |
| WingRiders / V2 | 1 / 0 | not declared | untested | untested |
| VyFinance | 0 | not declared | untested | untested |

The venue carrying 41 of 46 fills is exactly right. The venue that is badly wrong carries none.
