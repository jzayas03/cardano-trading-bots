# Minswap V2 charges 2 ADA per order, and its documentation says it charges nothing

Date: 2026-09-16
Venue: MinswapV2 (order script `c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c`,
enterprise address `addr1w8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnqst2ctf`)

## The claim, and why it was checked

`docs.minswap.org` states, today: *"As of May 2025, to celebrate its third anniversary, Minswap has
removed all batcher fees for users."* Acting on that would cut `VENUE_COSTS.MinswapV2` from 2 ADA to
zero, worth roughly 80 bps of round trip on a 500 ADA ticket, in the direction that makes every
strategy look better.

This is the second time the project has met this exact claim. The first is recorded in the
constitution's Principle I and pinned by `dexterWritesTheBatcherFee.guard.test.ts`: an LLM asserted
the same removal as policy and advised lowering the cost table. The rule that came out of it is that
**the submission path is the authority, not the documentation.**

So the question is not what Minswap publishes. It is what a Minswap V2 order actually carries on
chain, today, in the datum field the validator reads.

## Method (repeatable, costs no Blockfrost quota)

Koios is public and needs no key. `_after_block_height` bounds the window; widen it for more samples.

```bash
CRED=c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c
TIP=$(curl -sS https://api.koios.rest/api/v1/tip | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['block_no'])")

# 1. recent transactions touching the order script
curl -sS -X POST "https://api.koios.rest/api/v1/credential_txs?limit=8&order=block_height.desc" \
  -H 'content-type: application/json' \
  -d "{\"_payment_credentials\":[\"$CRED\"],\"_after_block_height\":$((TIP-2000))}" > txs.json

# 2. full transactions (NOTE: passing _outputs is a 404; outputs are always included)
HASHES=$(python3 -c "import json;print(json.dumps([r['tx_hash'] for r in json.load(open('txs.json'))]))")
curl -sS -X POST https://api.koios.rest/api/v1/tx_info -H 'content-type: application/json' \
  -d "{\"_tx_hashes\":$HASHES}" > info.json

# 3. outputs landing at the order credential carry a datum HASH (Dexter builds with
#    isInlineDatum:false), so resolve them
#    -> POST /datum_info with {"_datum_hashes":[...]}
# 4. the batcher fee is TOP-LEVEL FIELD 7 of the order datum, an int in lovelace.
```

Field 7 comes from Minswap's own `src/types/order.ts`, mirrored in Dexter at
`build/dex/definitions/minswap-v2/order.js`. The shape corroborates it independently: the datum has
nine top-level entries, and exactly one of them — position 7 — is a bare `int`; every other is a
constructor.

## Result, observed 2026-09-16 at block 13,949,171 (epoch 655)

| order tx | order value (ADA) | datum hash | field 7 (lovelace) | ADA |
|---|---:|---|---:|---:|
| `1dfbf2c8c2378089…` | 1,004.000000 | `3f08ecf2e0a6e065…` | **2,000,000** | **2.00** |
| `f14c1813f45b16f4…` | 688.004995 | `20b0c6bb3f2810eb…` | **2,000,000** | **2.00** |
| `1bbf64d21233e952…` | 625.622723 | `3b4135eff99ba7b0…` | **2,000,000** | **2.00** |
| `1a78406617e6c39b…` | 104.000000 | `f68a182b690b8abc…` | **2,000,000** | **2.00** |

**4 of 4 live orders carry 2,000,000 lovelace.** These are other people's
orders, from ordinary wallets, not ours and not Dexter's.

A second, independent corroboration is in the order values themselves. Two are round numbers plus
exactly 4 ADA: 104 = 100 + 4, and 1004 = 1000 + 4. That 4 is Dexter's
`batcherFee.value + deposit.value` — 2 ADA batcher fee marked `isReturned: false`, plus 2 ADA
deposit marked `isReturned: true`. The arithmetic of a stranger's order matches our model exactly.

## Verdict

**`VENUE_COSTS.MinswapV2` stays at 2,000,000 lovelace.** The number was right. What changes is its
provenance: it is no longer an inference from what Dexter writes, it is a measurement of what the
chain charges, and the `source` field now says so.

The documented removal is real for something — a V1 pool, a front-end subsidy, a policy the V2 order
contract does not implement — but it is not real for the path we would submit on.

## What this does not settle

- **Sample size.** Four orders in a ~11-hour window, unanimous. A fee change would show up as a
  mixed population, so re-run the method above each epoch, or before any change to the cost model,
  rather than treating this as permanent.
- **Whether the 2 ADA is consumed.** `isReturned: false` in Dexter and the +4 arithmetic both say
  the batcher keeps it. Reading a fulfilment transaction's outputs would prove it outright; not done.
- **Other venues.** Only MinswapV2 was measured. SundaeSwapV3's 1.28 ADA rests on the same
  Dexter-writes-it reasoning and deserves the same treatment.
- **The `basis` vocabulary.** `VenueCosts.basis` is `'documented' | 'assumed'`, and neither word fits
  a number measured on chain against documentation that disagrees. MinswapV2 is left at `'assumed'`
  here, which keeps the conservative warning in every report that touches it. Adding a `'measured'`
  grade would be more honest and would stop flagging this venue; that changes report output and is a
  founder decision, not a drive-by.
