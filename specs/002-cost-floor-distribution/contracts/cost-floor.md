# Contract: the cost-floor surface

**Date**: 2026-09-16 | **Data model**: [../data-model.md](../data-model.md)

Two contracts: the pure library surface in `@ctb/reports`, and the CLI command. Both are stated as
behaviour a test can check, not as code.

## 1. Pure surface — `packages/reports/src/costFloor.ts`

Pure by the existing guard: no `pg`, `@ctb/db`, `@ctb/cli`, `@ctb/collector`, `@ctb/candles`,
`node:child_process`, `node:fs`, `node:net`, `node:http`. May import `@ctb/sim-executor` (curve and
cost table) and `@ctb/engine` **types only**.

### `costObservations(snapshots, opts) -> CostObservation[]`

- **C1.1** One observation per (snapshot, size bucket). A snapshot with zero or negative reserves on either side yields **no** observation, not an `Infinity` one.
- **C1.2** `roundTripBps` is `impactBps + fixedFeeBps` and nothing else, where `impactBps` is **twice the one-way** shortfall against mid. CORRECTED 2026-09-16: pricing a there-and-back through the same pool makes own impact cancel exactly (0.000000 bps at `feeBps = 0`), which is true of a self-reversing trade and useless as a model of trading. See data-model.md.
- **C1.3** Fixed fees come from the venue's `VENUE_COSTS` entry, counted **twice** (once per leg), expressed over the lovelace notional.
- **C1.4** A venue absent from `VENUE_COSTS` yields no observation and an `ExclusionRecord`. It never falls back to a default cost — an unknown venue is a rejection, matching `simExecutor`.
- **C1.5** Monotonicity: for a fixed pool and tick, `impactBps` at a larger notional is **>=** the smaller one. Fixed-fee bps move the other way, so the assertion is on `impactBps`, not the total. **This is the assertion that caught the wrong model**, so it must be tested on a pool shallow enough that the curve, not integer truncation, is what moves.
- **C1.6** Exact arithmetic. Reserves and fees are `bigint` throughout; no `Number` division on lovelace before the final bps conversion.

### `costDistributions(observations, opts) -> { distributions, exclusions, provenance }`

- **C2.1** Grouped by `(poolId, sizeBucket)`. Never by venue — a venue-level aggregate is not produced at all, so it cannot be quoted by accident.
- **C2.2** `n < MIN_OBSERVATIONS` (default 30) sets `verdict: 'insufficient'` and **all four of `p50`, `p75`, `p90`, `floorBps` to `null`**. This is the FR-003 invariant and is asserted directly, not via the formatter.
- **C2.3** `n`, `firstTs` and `lastTs` are present on **every** distribution including insufficient ones. There is no code path that produces a distribution without them (FR-002).
- **C2.4** `floorBps === p90` exactly when sufficient (D2).
- **C2.5** `basis` is the weakest of the components. A route whose venue basis is `assumed` can never be reported as `measured`.
- **C2.6** Percentiles use the existing exported `quantile` from `opportunity.ts`. No fourth quantile implementation is added.
- **C2.7** Determinism: the same input yields byte-identical output, including ordering. Sorted by `(venue, poolId, sizeBucket)`.

### `lookupFloor(distributions, poolId, notionalLovelace) -> FloorAnswer`

- **C3.1** Returns exactly one of `floor` / `insufficient` / `excluded`. There is no default-bearing fourth case (FR-009, M6 §7 fail-closed).
- **C3.2** A notional between buckets resolves to the **larger** bucket — the more conservative answer.
- **C3.3** A notional above the largest bucket returns `insufficient`, never the largest bucket's figure extrapolated.
- **C3.4** An unknown `poolId` returns `excluded`, not `insufficient`. The two are different facts.

## 2. FR-006 control — `noSummedBpsMeasures.guard.test.ts`

This is the one that must be designed rather than assumed, because a test that passes today proves
nothing about tomorrow.

- **C4.1** Scans `packages/*/src/**/*.ts` **and** `docs/**/*.md` **and** `specs/**/*.md`. Docs are in scope because R7 found the live instances of this defect are in two published documents, not in code.
- **C4.2** Fails on any expression summing the two fill-time measures, in either order, in either casing (`slippageBps + priceImpactBps`, `slippage_bps + price_impact_bps`, and the reverse).
- **C4.3** Fails on a prose decomposition that charges the pool fee alongside an impact term — the `pool fee + impact` shape from `2026-09-09-strategy-state.md:40`.
- **C4.4** **Has a positive control**: the test contains a known-bad fixture string and asserts the detector flags it. Without this, a detector with a broken regex passes silently and the control is decorative — the exact failure this repo hit with a `shellcheck disable` bound to the wrong command.
- **C4.5** Has an explicit allowlist with a reason per entry, for text that legitimately *describes* the defect (this contract, the spec, `research.md`, and M6 §2.1 itself). An allowlist entry names the file and why, so the list cannot quietly grow.
- **C4.6** **Expected to FAIL on first run** against `docs/ops/2026-09-09-strategy-state.md` and `docs/ops/2026-09-09-token-choice-ada.md`. That is the control working. Those documents are corrected in a separate PR because fixing them changes published per-token floors, which is a cost-model claim.

## 3. CLI — `ctb cost-floor`

```
npm run cost-floor -- [--min-observations N] [--sizes 100,250,500,1000,2500]
                      [--since YYYY-MM-DD] [--pool <poolId>] [--json]
```

- **C5.1** Read-only. `SELECT` only; no write, no migration, no network.
- **C5.2** Output always contains, in order: the provenance block, the per-route table, the insufficient list, and the exclusions list. **The exclusions list is never omitted, even when empty** (FR-017).
- **C5.3** No bps figure is ever printed without its `n` beside it. Asserted as a rendering property, in the style of `opportunityRender.test.ts`'s "never a bare percentage" test.
- **C5.4** The provenance block states the `VENUE_COSTS` amounts and `basis`/`readAt` used, the snapshot date range, `MIN_OBSERVATIONS`, the size buckets, and that the figures are **modelled, not realised** (FR-007).
- **C5.5** Exit code is 0 whether or not any route is sufficient. "No route has enough data" is a finding, not an error.
- **C5.6** `--json` emits the same structure as data, for the M6.3 consumer that does not exist yet.
- **C5.7** Rendering is a `render*` returning `string[]`; the caller does the `console.log`.

## 4. What no contract here permits

- Writing to any table.
- Reading or printing `.env`, a key, or any secret.
- Any network call.
- Changing `VENUE_COSTS`, `MIN_ROUND_TRIPS`, `DEFAULT_FLOOR_BPS`, or `DEFAULT_MAX_IMPACT_BPS`.
- Emitting a single global floor figure. The command cannot print one, because `costDistributions` never computes one (C2.1).
