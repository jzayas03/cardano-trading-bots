# Multi-pool splice: making it visible in the run report

## The finding, restated

`buildCandles` (`packages/candles/src/build.ts`) always picks the single deepest pool per tick for
a token. That's correct and documented. What it also means: when the deepest venue drops out (a
provider error, a liquidity drain), the next-deepest pool is promoted, and the candle series keeps
going — silently — on a different pool. Two pools on the same token are different price series
(different fee, different depth, a different quote), so a step in the series at that point is a
venue change, not a market move. Each candle row already carries its `pool_id`; nothing surfaced it.

## Shape I chose, and why

Matched the existing coverage/warning mechanism exactly rather than inventing a parallel one.

1. **`RunCoverage.distinctPools?: number`** (`packages/engine/src/types.ts`) — one more field
   alongside `candles`/`expectedBuckets`/`maxGapMs`/`gapsOverBound`. Optional, not required: a run's
   `summary` is a jsonb blob (`runs.summary`), and a run persisted before this change simply won't
   have this key when read back — `undefined` at runtime regardless of what the TS type would
   otherwise claim. Making it optional in the type is honest about that, and lets `coverageLine`
   check it defensively the same way `feedCountersLine` already treats its own jsonb blob.

2. **Computed in the engine's loop** (`packages/engine/src/loop.ts`), not in `@ctb/reports` or the
   dashboard. A `Set<string>` (`poolsSeen`) collects `candle.poolId` for every candle the loop
   actually consumes from the feed in `runEngine` — seeded empty, **never** from `primeHistory`,
   matching the existing rule that `candles`/`firstTs`/`lastTs` only describe what THIS segment
   consumed (a resumed run must not double-count history it already lived through). A `null`
   `poolId` (external-source candles, `dev:fake-collector`, etc.) doesn't count as a pool. The count
   lands on `coverage.distinctPools` next to the other counts.

3. **`coverageLine`** (`packages/reports/src/format.ts`) appends ` | N pool(s)` to the existing
   pipe-delimited line, or `not recorded (run predates pool tracking)` when the field is absent —
   the same "say so, never imply 0 or 1" rule the whole function already follows for a completely
   missing `coverage`. No existing segment of the line changed; nothing else it prints moved.

4. **Warning in `runEngine`** (`packages/engine/src/loop.ts`), same place and same shape as the
   existing "produced zero intents" / "none filled" warnings — pushed onto `summary.warnings`,
   logged via `d.log.warn`. Fires whenever `poolsSeen.size > 1`:
   `candle series spans ${n} pools: ${sorted pool ids joined by ", "}`. Naming *which* is free — the
   pool ids are already in hand from the candles the loop just walked, no extra I/O — so it always
   names them, sorted for determinism across identical runs. Full `dex:identifier` pool ids are used
   (not just the dex prefix) because that's the exact granularity `pool_id` already carries and
   nothing computed it further; a helper that strips to the dex name (`venueOf`) lives in
   `@ctb/sim-executor`, which the engine cannot import without a circular dependency, so this stays
   in the engine's own vocabulary.

No dashboard changes were needed: `packages/dashboard/src/pages/runs.ts` already calls
`coverageLine(run.summary?.coverage)` and iterates `run.summary?.warnings ?? []` generically, so
both pick up the new segment/warning automatically — satisfying "the dashboard computes no numbers
of its own."

## Real-data verification

Ran two fresh backtests over the identical window (`2026-09-06T20:00:00Z` ->
`2026-09-07T23:00:00Z`), `--source candles`, against the shared local dev Postgres
(`postgres://ctb:ctb_local_only@localhost:5433/ctb`).

### SNEK (spliced across two pools) — new run 135

```
$ DATABASE_URL=postgres://ctb:ctb_local_only@localhost:5433/ctb npx tsx packages/cli/src/main.ts backtest ma-crossover SNEK 2026-09-06T20:00:00Z 2026-09-07T23:00:00Z --source candles
```

Coverage line:
```
coverage: 115 of 153 expected buckets (75.2%) | 2026-09-06T20:50:00.000Z -> 2026-09-07T22:10:00.000Z | max gap 200m | 19 gaps over the stale-fill bound | 2 pools
```

Warnings:
```
warning: candle series spans 2 pools: MinswapV2:f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c2ffadbb87144e875749122e0bbb9f535eeaa7f5660c6c4a91bcc4121e477f08d, WingRidersV2:6fdc63a1d71dc2c65502b79baae7fb543185702b12c3c5fb639ed737e3b382a85249ef92357e00bd42c088c69c1eac2a736ae2df34dd2b89de11de1a
warning: fills touched venues with ASSUMED costs: MinswapV2 (see runs.params.costs.venues)
```

### ASCEND (single pool throughout) — new run 136

```
$ DATABASE_URL=postgres://ctb:ctb_local_only@localhost:5433/ctb npx tsx packages/cli/src/main.ts backtest ma-crossover ASCEND 2026-09-06T20:00:00Z 2026-09-07T23:00:00Z --source candles
```

Coverage line:
```
coverage: 101 of 153 expected buckets (66.0%) | 2026-09-06T20:50:00.000Z -> 2026-09-07T22:10:00.000Z | max gap 200m | 20 gaps over the stale-fill bound | 1 pool
```

Warnings:
```
warning: fills touched venues with ASSUMED costs: MinswapV2 (see runs.params.costs.venues)
```
(no multi-pool warning — as expected, the series never left MinswapV2)

### A run that predates the change — run 129 (SNEK, same window, run before this code existed)

```
$ DATABASE_URL=postgres://ctb:ctb_local_only@localhost:5433/ctb npx tsx packages/cli/src/main.ts report 129
```

```
coverage: 115 of 153 expected buckets (75.2%) | 2026-09-06T20:50:00.000Z -> 2026-09-07T22:10:00.000Z | max gap 200m | 19 gaps over the stale-fill bound | not recorded (run predates pool tracking)
```

No multi-pool warning is printed for run 129 either — its persisted `summary.warnings` was written
before this change existed, so it has none, and `coverageLine` correctly says "not recorded" instead
of inventing a 0 or a 1 for a run this code never measured.

### Dashboard

Started the dashboard against the same real (non-test) database (`DASHBOARD_DATABASE_URL` derived
from `~/code/cardano-trading-bots/.env`'s `DATABASE_URL` — contents never printed) on port 3245, and
loaded `/runs/135` and `/runs/136` in the browser pane:

- Run #135 (SNEK) page shows the identical coverage line ending `| 2 pools` and the
  `candle series spans 2 pools: ...` warning line, styled the same as the existing
  `fills touched venues with ASSUMED costs` warning right below it.
- Run #136 (ASCEND) page shows `| 1 pool` and no multi-pool warning.

Server was killed after inspection (`pkill -f "cli/src/main.ts dashboard"`); confirmed no process
left listening on port 3245.

## Verification commands and results

- `npm run lint` — clean (`eslint . && tsc -p tsconfig.json`, no errors).
- `npm test` — 617 passed, 45 skipped, 0 failed (65 test files).
- `DATABASE_URL=postgres://ctb:ctb_local_only@localhost:5433/ctb npm run test:pg` — 660 passed, 2
  skipped, 0 failed (79 test files; the skip is the live-network Dexter test, unrelated).

New/changed tests:
- `packages/engine/test/loop.test.ts`: updated the two existing coverage-shape assertions to include
  `distinctPools`, and added a new `describe('runEngine multi-pool coverage and warning', ...)` block
  covering: single-pool series (count 1, no "spans" warning), a series that splices across two named
  venues (count 2, warning text and log line asserted exactly, sorted), and a candle with `poolId:
  null` not counting toward the total.
- `packages/cli/test/report.test.ts`: extended `coverageLine` fixtures with `distinctPools`, and
  added a case asserting the plural/singular wording (`2 pools` vs `1 pool`) and the "not recorded
  (run predates pool tracking)" text when the field is absent from an otherwise-complete
  `RunCoverage`.

## What's worrying me

- The warning names full `dex:identifier` pool ids, which are long opaque hex strings past the dex
  prefix. That's exactly what's on the candle (cheapest, most precise, zero risk of two different
  pools on the same dex reading as "the same pool"), but it makes the warning line visually noisy in
  a terminal — an operator skimming for "did this splice" gets the fact clearly, but has to squint
  past the hash to see *which two dexes* were involved. I considered truncating to the dex prefix
  (`MinswapV2`, `WingRidersV2`) via the same one-line split `venueOf` does in `@ctb/sim-executor`,
  but engine cannot depend on sim-executor (sim-executor depends on engine) without introducing a
  cycle, and duplicating that one-liner felt like the wrong tradeoff for a report string. If the
  operator would rather see just the dex names, that's a follow-up worth a short discussion rather
  than a unilateral call on my part.
- `coverage.candles` (75.2%/66.0% of expected buckets in both real runs) is itself sparse for
  unrelated reasons (documented collector history), and a sparse window plus a pool splice compound —
  a reader now sees both facts on the same line, which is the intent, but it's worth knowing the two
  real verification runs both happen to be doubly-caveated rather than one clean baseline.
