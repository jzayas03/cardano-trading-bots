# M6: live execution

Date: 2026-09-08. Status: draft design, pre-implementation. **No code follows from this document
until the founder has read it and the preconditions below are met.**

Builds on: `docs/specs/2026-09-05-paper-trading-foundation.md` (M0-M3),
`docs/specs/2026-09-07-m4-dashboard.md`, `docs/specs/2026-09-08-m5-deployment.md`.

## 1. Purpose

Turn a strategy that has proven itself on paper into one that places real orders on Cardano DEXes
under fixed rules, and sweeps realised profit to a cold wallet on a schedule.

Success means: the bot places, confirms and reconciles real swaps; every rule that can stop it is
enforced in code rather than remembered; and the operator can halt it from a phone.

**This milestone spends real money and can lose it.** Everything below is written on that basis.

## 2. What must be true before any of this is built

These are gates, not preferences.

1. **A strategy has cleared the cost floor on paper, on a full clean week.** Measured 2026-09-08
   from run 139's first real fill — 990 ADA into NIGHT on MinswapV2:

   | | |
   |---|---|
   | slippage (fill vs mid, incl. pool fee) | 86 bps |
   | of which our own price impact | 34 bps |
   | batcher + network | 2.20 ADA = 22 bps |
   | **one way** | **108 bps** |
   | **round trip** | **216 bps = 2.16%** |

   Every buy/sell cycle must beat 2.16% before a cent is kept — and that is the OPTIMISTIC figure.
2. **The 7-day run is from the VPS**, not the laptop, whose 16-of-64 boundaries make it a soak test
   rather than evidence.
3. **Dexter's swap path is proven against `MockWalletProvider`, then on preprod with worthless
   ADA.** That it exists is not evidence it works; we have only ever used its read path.

## 3. Decisions already made

- **The founder holds the keys and arms live mode.** No agent handles a seed phrase, a signing key,
  or the flag that turns this on. This is not a preference about tooling; it is the boundary.
- **The hot wallet holds working capital only.** It is the largest risk surface in the system.
- **The profit sweep is a security control, not a feature.** It exists to keep the hot wallet small.
- **Order construction uses Dexter.** Each DEX's order is a datum posted to a batcher contract, not
  a payment; getting it wrong loses funds rather than erroring, and Dexter already encodes it for
  MinswapV2, SundaeSwap, WingRiders and MuesliSwap — the venues we collect. Re-implementing that is
  the wrong risk to take.

## 4. The open technical question

Signing and submission. Two candidates, and the spec deliberately does not pick yet:

| | Dexter `LucidProvider` | MeshJS |
|---|---|---|
| new dependencies | none | one SDK |
| maintenance | `lucid-cardano`, older | active |
| known trouble here | WASM will not bundle; axios CVEs arrived this way | none yet |
| provider | Blockfrost | Blockfrost |
| testing without funds | **`MockWalletProvider`** | its own emulator |

`MockWalletProvider` is what tips the first experiment toward Dexter: the whole path — build, sign,
submit — can be exercised with no key and no funds. The decision is made by that experiment, not by
this table.

## 5. What paper does not model, and live must

The paper loop decides its own fills. On-chain, a batcher decides, and the gap between those is the
substance of this milestone.

- **The order may not execute.** It sits in a batcher queue. It can expire.
- **The price moves between submit and execution**, in a direction that is not random when someone
  is watching the mempool.
- **Partial fills.**
- **Submission can fail** — bad UTxO set, insufficient collateral, a rollback.
- **The chain can roll back** a confirmed transaction.

## 6. Reconciliation: the part that cannot be skipped

Paper has two outcomes, `filled` and `rejected`, and we choose them. Live has a third that the
schema does not currently admit: **submitted, outcome unknown**.

A live order is therefore a state machine — `intended -> submitted -> confirmed | failed | expired`
— carrying its transaction hash, and every state change is a fact read back from the chain, never
an assumption from what we sent. The bot's idea of its own position must be **derived from
confirmed on-chain state**, and a divergence between intended and actual position is a stop
condition, not a warning.

This is the single largest piece of work in M6, and it is larger than the trading logic.

## 7. Risk controls, which are worth more than the strategy

Enforced in code, checked before every submission, and each one proven by making it fire:

| Control | Rule |
|---|---|
| Max position | never more than N ADA in one token |
| Max order size | never more than N ADA in one order |
| Daily loss limit | stop for the day at a realised loss of N |
| Slippage ceiling | **abort** the order if quoted slippage exceeds N bps — never accept a worse price |
| Minimum edge | refuse any round trip whose expected move does not clear the measured cost floor |
| Kill switch | one command, reachable from a phone, that stops trading and leaves positions untouched |
| Dry run | build and log the real order without submitting; the default until explicitly armed |

Fail closed everywhere: an unreadable price, an unknown venue, a stale candle, a failed
reconciliation all mean **do not trade**, never "assume and proceed".

## 8. Custody and the sweep

The hot wallet holds only working capital. On a schedule, realised profit above a threshold is sent
to a **cold address the bot cannot spend from** — the destination is configuration the bot reads and
never derives, and the sweep is one-way by construction.

Keys live in the host's secret store, readable only by the service account, never in the repo, an
image, a log, or a shell history — the same rule the Blockfrost key already follows, with a rotation
procedure written down before the first funded trade rather than after.

## 9. Milestones

| | |
|---|---|
| M6.1 | Dexter's swap path proven against `MockWalletProvider`; no key, no funds |
| M6.2 | The order state machine and reconciliation, against preprod |
| M6.3 | Risk controls, each proven by making it fire |
| M6.4 | Dry-run mode against mainnet prices: real orders built and logged, never submitted |
| M6.5 | One funded trade on mainnet at minimum size, reconciled by hand |
| M6.6 | The sweep, proven by sweeping |

M6.5 is a founder decision on the day, not a step an agent takes.

## 10. Out of scope

Cross-DEX arbitrage. Market making. Leverage or borrowing. Anything on a chain other than Cardano.
Multiple concurrent strategies with real funds — one strategy, one wallet, until it is boring.

## 11. Open questions

- **Which strategy, if any.** Decided by the week's results against the 2.16% floor, not here.
- **How much working capital**, and the sweep threshold and cadence.
- **The cold destination**, which the founder creates and the bot only ever reads.
- **Signing library**, decided by M6.1.
- **What "stop permanently" means** — the loss at which the answer is to turn it off rather than
  tune it. Worth writing down before there is money on the table and an argument for continuing.
