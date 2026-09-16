# Minswap V2 does not vary by pool, and charges exactly what it declares

Date: 2026-09-16
Venue: MinswapV2 — **the only venue this project actually fills against** (41 of 46 paper fills).
Asked because [Splash turned out to vary by pool](2026-09-16-splash-fee-is-per-pool.md), which would
be far more serious here.

**Answer: no, on both counts.** Nothing changed.

## Question 1 — does the declared fee vary by pool?

26 order datums sampled, grouped by the pool identifier in datum field 5:

| pools sampled | orders | distinct declared batcher fees |
|---:|---:|---|
| 10 | 26 | **`2.0 ADA` only** |

No variation. Contrast Splash, where two pools charged two different formulas.

## Question 2 — does the batcher take what it declares?

This is the question the Splash read made necessary: there, the datum declared 3 ADA and the
executor took up to 7.6. Thirty-four fulfilment transactions were pulled and reconciled the same
way — net every input and output per credential, identify the user from the datum, and read the
cost as the batcher's net gain plus the network fee.

Worked example, `7661e18a82afad32`:

| credential | net ADA | what it is |
|---|---:|---|
| `636d0d0118a8` | +2,374.2268 | the user |
| `ea07b733d932` | −2,372.2268 | the pool, paying out |
| `c3e28c36c344` | −4.0000 | the order script (2 fee + 2 deposit) |
| `5b7e23228dba` | **+1.3353** | the batcher |
| network fee | 0.6647 | |

Batcher net 1.3353 plus the 0.6647 network fee it paid = **exactly 2.000000 ADA**. The user's 2 ADA
deposit came back inside their 2,374.2268. Cost above the pool's payout: 2.0000 ADA, which is the
declared fee to the lovelace.

Across every reconcilable swap:

| result | count |
|---|---:|
| cost exactly `2.000000` ADA | **28** |
| heuristic could not attribute (see below) | 2 |
| cancellations, no pool involved | 4 |

**28 of 28 attributable swaps cost exactly the declared 2 ADA. No proportional component, no
per-pool variation, no gap between declared and taken.**

The two unattributable rows are ADA-input swaps where the user's only ADA output is the returned
2 ADA deposit, so the "smallest net is the batcher" heuristic picks the wrong credential and returns
roughly the network fee. They are a limitation of the method, **not** evidence of a different fee;
both declared 2 ADA. Attributing them needs the pool credential known in advance.

## What did turn up: the fee is user-settable

One order declared **8 ADA**, not 2. It was cancelled rather than filled, so it was never charged —
the user reclaimed 9.76 of the 10 ADA held, the rest being the network fee, and no pool was
involved.

So `BatcherFee` is a field the submitter chooses, presumably bid upward for priority, with 2 ADA as
the ordinary floor. Dexter writes 2, so our submission path pays 2 and the model is right for us.

**This is the concrete argument for M6 §7.2** — "the fee written into the order datum is read live,
never inherited from Dexter's hardcoded default". The field demonstrably varies between submitters.
Today that costs us nothing because we submit through Dexter at the floor. It would cost us the
moment anything else builds the order, and the model would have no way to know.

## Where this leaves the table

| venue | fee shape | varies by pool? | declared = taken? |
|---|---|---|---|
| MinswapV2 | flat 2 ADA | **no** (10 pools) | **yes**, exactly (28 swaps) |
| SundaeSwapV3 | flat 1.28 ADA | no (4 pools) | not reconciled |
| Splash | 2 ADA **+ up to 1%** | **yes** | **no** — declared 3, took up to 7.6 |

The venue carrying every fill is the well-behaved one. That is worth knowing with evidence rather
than by assumption, and it means no past result is affected by the Splash finding.

## Still open

- SundaeSwapV3 fulfilments were never reconciled — its 1.28 is confirmed as *declared* across four
  pools, but nobody has checked what the scooper actually takes. It carries 1 fill.
- The two unattributable ADA-input swaps, which need the Minswap V2 pool credential.
