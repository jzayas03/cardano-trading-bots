# Quickstart: validating the cost floor distribution

**Date**: 2026-09-16 | **Contract**: [contracts/cost-floor.md](./contracts/cost-floor.md)

How to prove this feature works, and what the answers should be. Predictions are written **before**
implementation (research.md R9) so a surprising result is investigated rather than accepted.

## Prerequisites

```bash
nvm use
docker compose up -d postgres
npm run migrate
```

Snapshot data is required. A developer machine may have little or none — the 19,948 measured-venue
snapshots live on the VPS. Scenario 4 is the one that needs real data; 1 to 3 run anywhere.

## Scenario 1 — the gate

```bash
npm run lint
npm run lint:sh
npm run test:pg
```

All three green. `npm test` and `npx vitest` are **not** evidence: they skip every Postgres test.

## Scenario 2 — the insufficiency invariant holds structurally

```bash
npx vitest run packages/reports/test/costFloor.test.ts
```

The load-bearing assertions:

- A bucket with `n = 29` returns `verdict: 'insufficient'` **and `p50`, `p75`, `p90`, `floorBps` all `null`** (C2.2). Not "renders as blank" — null in the data.
- `n`, `firstTs`, `lastTs` present on every distribution including insufficient ones (C2.3).
- `floorBps === p90` when sufficient (C2.4).
- An unknown venue produces an `ExclusionRecord` and no observation, never a default cost (C1.4).
- `lookupFloor` on an unknown pool returns `excluded`; between buckets it rounds **up**; above the top bucket it returns `insufficient` rather than extrapolating (C3.2-C3.4).

## Scenario 3 — the FR-006 control catches the defect it exists for

```bash
npx vitest run packages/reports/test/noSummedBpsMeasures.guard.test.ts
```

**This test is expected to FAIL on first run.** That is the deliverable, not a problem. It should
name `docs/ops/2026-09-09-strategy-state.md:40` and `docs/ops/2026-09-09-token-choice-ada.md:14-23`,
which carry `pool fee + impact(depth) + 22 bps spread + 22 bps batcher` — the pool fee charged twice
plus an invented spread term.

Also check the positive control passes (C4.4): the test's own known-bad fixture must be flagged. A
detector that finds the two documents but would not flag a fresh instance is decorative.

Do **not** fix those documents in this PR. Their per-token floors (ASCEND 477, STRIKE 411, SNEK 371,
WMTX 561) are published cost-model claims; correcting them is a founder-gated change.

## Scenario 4 — a real run against real data

On the VPS, or against a restored copy:

```bash
npm run cost-floor
```

**Expected, from the snapshot counts measured 2026-09-16:**

| expectation | why |
|---|---|
| MinswapV2: most (pool, size) cells **sufficient** | 19,756 snapshots, 20 pools, 2,407 ticks |
| SundaeSwapV3: most cells **insufficient** | 192 snapshots over 9 pools and 30 ticks is ~21 per pool |
| Exactly 4 venues excluded as `unmeasured-fee` or `varies-by-pool` | WingRiders, WingRidersV2, VyFinance, Splash |
| `synthetic` and `Fake` excluded as `not-a-market` | 3,514 and 3 fills respectively; neither is a market |
| p90 **above** 216 bps at 2,500 ADA on thin pools | impact grows with size; 216 came from 990 ADA on one deep pool |
| p90 possibly **below** 216 bps at 100 ADA on deep pools | the fixed 2.2 ADA is 22 bps at 1,000 ADA but 220 bps at 100 |
| No single global figure anywhere in the output | `costDistributions` cannot compute one (C2.1) |
| Exit code 0 even if nothing is sufficient | that is a finding, not an error (C5.5) |

**Investigate rather than accept** if: a global number appears; SundaeSwapV3 reports n>=30 on most
pools; MinswapV2's 20 pools show no per-pool spread; or any bps figure prints without its `n`.

## Scenario 5 — the quote model agrees with the fills we have

```bash
npm run cost-floor -- --json | <compare against paper_orders>
```

Replay the 41 filled MinswapV2 orders through the same curve code at their own notional and compare
the modelled one-way impact against each fill's stored `slippage_bps`.

**This is a sanity check, not a validation.** 41 observations across 3 pools cannot validate a model.
It will catch a sign error, a units error, or a factor-of-two — the failure modes that matter most
and are easiest to miss. Expect modelled impact to be **smaller** than stored `slippage_bps`, because
slippage measures the fill against the decision-time mid and therefore also contains whatever the
price did between t and t+1, which a same-tick quote cannot contain.

If modelled impact comes out **larger** than stored slippage, something is wrong: the quote is
charging a cost the fill did not pay.

## Scenario 6 — nothing moved that was not supposed to

```bash
git diff origin/main --stat -- packages/sim-executor/src/costs.ts \
    packages/reports/src/promotion.ts packages/sim-executor/src/depth.ts \
    .specify/memory/constitution.md
```

**Must be empty.** No fee value, no promotion threshold, no depth threshold, no constitutional
wording changed. If this feature wants any of them changed, that is a stop-and-ask, not a diff.
