# M4b + M4c: the compare page and the universe screener

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/compare?ids=…` puts several runs' persisted headlines in one table and their equity curves on one chart, reachable by ticking boxes on the runs list with no JavaScript; `/universe` shows the 20 tokens with their deepest pool, ADA depth, price, 24-hour change and external-history coverage, sortable server-side.

**Architecture:** No new package. `@ctb/dashboard` gains two page modules, three read-only queries and a multi-series chart; `@ctb/reports` gains one pure function (`priceChangePct`) because the dashboard may not compute a percentage itself. The runs list gains a checkbox column and a GET form, which is the whole selection mechanism — a form submits `?ids=…` and no script runs.

**Tech Stack:** unchanged (Node 24, TypeScript strict, tsx, Vitest, pg). No new dependency; uPlot is already vendored.

**Spec:** `docs/specs/2026-09-07-m4-dashboard.md` — §4.2 `/compare` and `/universe`, §4.3 `latestSnapshotsPerToken`/`snapshotAt`/`externalCoverageAll`, §3 boundaries, §8 M4b and M4c. Answers the spec's own §10 open question about where the 24-hour change comes from.

**Plan M4a:** `docs/plans/2026-09-07-m4a-dashboard-core.md` (merged, PRs #36-#43).

## Facts verified on 2026-09-07 (do not re-derive; read from `main` at c973458+)

- `@ctb/reports` exports: `adaStr`, `coverageLine`, `feedCountersLine`, `resumesOf`; `summarizeDay`/`summarizeRun`; the digest set; the doctor checks; `heartbeatAgeCell`/`isHeartbeatStale`; `compareRows`, `compareRunRows`, `sweepRows`; `gridCombinations`, `gridRows`, `gridWarning`. It imports only `@ctb/engine` types — its purity guard forbids `pg`, `@ctb/db`, `@ctb/cli`, `@ctb/collector`, `@ctb/candles`, `node:fs`, `node:child_process`, and walks subdirectories.
- `compareRunRows(inputs: CompareRunInput[], now: Date): CompareRunRow[]` where `CompareRunInput = { run: RunRow; ticker: string; equity: EquityPoint[]; orders: OrderRecord[] }`. It already emits `basis: 'rows' | 'summary'`, the REHEARSAL marker and a heartbeat cell only for a running paper run.
- `packages/dashboard/src/chart.ts` exports exactly `equitySeries` and `chartHtml`; that export surface is PINNED by `oneRule.guard.test.ts` (AST-based, covering function/class/variable/`export {}`/default/`export *`/enum/namespace), and `chart.ts` is the one file exempt from the arithmetic scan. Adding an export there is a deliberate act that fails the guard until the pin is updated.
- `packages/dashboard/src/html.ts` exports `escape`, `statusWord` (returns a `RenderedCell`), `layout(title, body, { refreshSec?, rehearsal?, chart? })` — `chart: true` emits the uPlot `<script src>` — `table(columns, rows)` where a cell is a scalar or a `RenderedCell` (passed through unescaped), and `REHEARSAL_BANNER`.
- `packages/dashboard/src/reads.ts` has `RUN_MODES`, `RUN_STATUSES`, `RunFilter`, `DashboardReads` (only `listRuns` today) and `PgDashboardReads`, whose `listRuns` clamps `limit` to [1, 500] and parameterises every clause. Its header already notes that `latestSnapshotsPerToken`, `snapshotAt`, `externalCoverageAll` and `runsSharingGrid` are left "for whichever task adds the page that needs them".
- `packages/dashboard/src/server.ts`: `DashboardDeps` carries `reads`, `runs` (`getRun`/`listOrders`/`listEquity`), `collector.digestInput`, `processes`, `migrations`, `fakeRows`, `envChecks`, `tickerOf`, `unitOf`, `tickers`, `intervalSec`, `venues`, `now`, `log`. `handleRequest` rejects a `//`-prefixed target, parses inside a try, and backstops the handler with `.catch`; `listen` binds `127.0.0.1` only.
- `readOnly.guard.test.ts` reflectively invokes every `PgDashboardReads` prototype method AND own instance field, recording SQL and failing on anything not `SELECT`/`WITH` — so a new read method is covered automatically, and one that cannot be invoked with its generic-safe defaults fails loudly.
- `@ctb/candles` exports `priceAdaPerToken(reserveQuote, reserveBase, decimals): Decimal` and `decimalToScaled`. It imports `pg`, so it may be imported by `@ctb/dashboard` (which already has `pg`) but never by `@ctb/reports`.
- `pool_snapshots` columns include `tick_ts, dex, pool_id, base_unit, reserve_base, reserve_quote, fee_bps, pool_type, tvl_lovelace`. `external_pool_map` has `base_unit, external_pool_id, external_dex, match_method, reserve_usd`; `candles_external` has `base_unit, tick_ts, external_pool_id, open…close, volume_quote`. `PgExternalRepo.coverage(unit)` returns `{ first, last, rows }` for ONE unit.
- Live dev database, 2026-09-07 17:40 UTC: `pool_snapshots` spans 2026-09-06 20:50 to now, 88 distinct ticks in the last 26 hours, 20 tokens covered on the newest tick, MinswapV2 the deepest pool for all 20. So a 24-hour-ago snapshot exists for part of the universe today and for all of it from tomorrow.
- `universe.json` is ordered by market-cap rank as seeded (`seedSource` records the konnektr query); `loadUniverse()` preserves that order, so array position IS the rank.
- `docs/ops/RUNBOOK-dashboard.md` describes the health page, `/runs` and `/runs/:id`, states the read-only role as the enforcement, records the temp-table limitation, and tells the operator to file a bug rather than reconcile by hand if a page and the CLI disagree.

## Global Constraints

- Everything in Plan M4a's Global Constraints still binds. In particular:
  - **The one rule.** `packages/dashboard/src` computes no numbers. Every figure is the return value of a function imported from `@ctb/reports` (or `@ctb/candles`/`@ctb/sim-executor` for a figure those packages own). `chart.ts` is the only arithmetic-exempt file and its export surface is pinned; **adding an export there requires updating the pin in the same commit and saying why in the report.**
  - **Read only.** Every query `SELECT`/`WITH`, parameterised, bounded. New `PgDashboardReads` methods are picked up by the read-only guard automatically; make sure each is invocable with generic-safe arguments so the guard can actually drive it.
  - Localhost-only bind, secrets never rendered, REHEARSAL banner from the persisted flag, tables never sorted by return unless the operator asked.
  - ESM, strict TS, no `any`, no empty catch without `// intentional:`, pg tests behind `RUN_PG_TESTS=1` inside `withTestSchema`, every new guard proven red, one PR per task off `main`, CI green before merge.
- **No JavaScript beyond the vendored chart.** Selection, sorting and paging are GET forms and query parameters. The page must work with scripting disabled except for the chart itself.
- **A number's absence is rendered, never guessed.** A token with no snapshot, no 24-hour-ago snapshot, or no external history shows `-`, never 0 and never a stale value.

---

### Task 1: `/compare` — the multi-run table and the shared chart (its own PR)

**Files:**
- Create: `packages/dashboard/src/pages/compare.ts`, `packages/dashboard/test/compare.test.ts`
- Modify: `packages/dashboard/src/chart.ts` (multi-series), `packages/dashboard/test/oneRule.guard.test.ts` (the chart export pin), `packages/dashboard/src/pages/runs.ts` (checkbox column + form), `packages/dashboard/src/server.ts` (route), `packages/dashboard/test/{runs,server,chart}.test.ts`

**Interfaces:**
- Consumes: `compareRunRows`, `adaStr` from `@ctb/reports`; `runs.getRun`/`listOrders`/`listEquity`; `table`, `layout`, `escape`, `REHEARSAL_BANNER` from `html.ts`.
- Produces:
  - `chart.ts`: `export interface NormalisedSeries { label: string; ts: number[]; pct: Array<number | null> }` and
    `export function normalisedEquitySeries(runs: Array<{ label: string; points: EquityPoint[] }>): NormalisedSeries[]` — each run's equity as a percentage of its OWN first point, so runs started with different cash share one axis (spec §4.2). This is arithmetic and therefore lives in `chart.ts`, the file the one rule already exempts as the plotting boundary; it goes through `adaStr` exactly as `equitySeries` does. A run with fewer than two points contributes no series.
    `export function multiChartHtml(id: string, series: NormalisedSeries[]): string` — one uPlot with an x axis of unix seconds and one line per run, labelled `run <id> <strategy>`.
  - `pages/compare.ts`: `export function renderCompare(input: { inputs: CompareRunInput[]; now: Date }): string`.
- The `oneRule.guard.test.ts` chart-export pin becomes exactly `{equitySeries, chartHtml, normalisedEquitySeries, multiChartHtml}` **and the guard must still fail on a fifth export** — prove it.

- [ ] **Step 1: Normalised series + multi-series chart, with tests**

`normalisedEquitySeries` maps each run's points to `Number(adaStr(p.equityLovelace))` and then to `((v / v0) - 1) * 100` against that run's own first value; a first value of 0 makes every point `null` (there is no percentage of nothing) rather than dividing. Test: two runs of very different cash sizes that both double produce identical `pct` arrays ending at 100; a run whose first equity is 0 yields all-null; a run with one point is dropped; `ts` is unix seconds.

- [ ] **Step 2: Update the chart export pin and prove it still bites**

Extend the pinned set to the four exports. Then add a fifth export to `chart.ts`, run `npx vitest run packages/dashboard/test/oneRule.guard.test.ts`, confirm it fails naming the extra export, remove it, confirm green. Paste the failure message in your report.

- [ ] **Step 3: `renderCompare`**

Order is the order the operator listed the ids — never sorted. Layout, in order: the REHEARSAL banner when any input run is a rehearsal; a heading naming the ids, the tickers and `as of <now>`; the mixed-token warning when the inputs span more than one ticker, worded exactly as the CLI's `printCompare` words it; the `compareRunRows` table via `table()`; then the chart when at least one input has two or more equity points, else a line saying no run in this comparison has enough persisted equity points to chart. Every cell goes through `table()`'s escaped path.

- [ ] **Step 4: The route**

`GET /compare` accepts **both** `?ids=1,2,3` and repeated `?ids=1&ids=2` (the checkbox form produces the second), merging them in order of appearance. Validation, each a 400 naming what is accepted: no ids at all; a non-integer or non-positive id; a repeated id; more than 12 ids (a chart with more lines than that is unreadable and the query cost is linear). A 404 naming the id when `getRun` returns null for any of them. For each id, `Promise.all([listOrders, listEquity(id, new Date(0), now)])` — the same reads `/runs/:id` performs.

- [ ] **Step 5: Selection on the runs list**

Wrap the list table in `<form method="get" action="/compare">` with a checkbox `<input type="checkbox" name="ids" value="<id>">` as the first cell of each row and a submit button labelled `compare selected` above and below the table. No script. The existing filter form must keep working — they are two separate forms, so make sure the markup does not nest them (nested forms are invalid HTML and the browser drops the inner one). Test the rendered markup for both forms being siblings, the checkbox names, and that a filtered list keeps its filters in the filter form only.

- [ ] **Step 6: Verify**

`npm run lint`, `npm test`, `npm run test:pg`. Then live, read-write credentials because the read-only role has no grants in the real schema until the operator migrates:
`set -a && source ~/code/cardano-trading-bots/.env && set +a && DASHBOARD_DATABASE_URL="$DATABASE_URL" npx tsx packages/cli/src/main.ts dashboard --port 3230`
- `/compare?ids=6,7` renders the REHEARSAL banner, two rows, and a chart with two lines.
- `/compare?ids=105,106,107` (three backtests of one sweep) renders three rows and the no-equity line, since backtests persist no equity.
- `/compare?ids=6,105` warns about mixed tokens if their tickers differ.
- `/compare?ids=6&ids=7` behaves identically to `?ids=6,7`.
- `/compare` with no ids, with `?ids=abc`, with `?ids=6,6`, and with thirteen ids each return 400 naming the rule; `?ids=999999` returns 404.
- Compare the table's cells against `npx tsx packages/cli/src/main.ts report --compare 6,7`; they must match.
`.env` holds a real API key: never print, echo or paste its contents. Kill the server after.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(dashboard): /compare — several runs' headlines in one table and their equity curves on one chart

Selection is a GET form of checkboxes on the runs list, so nothing but the vendored chart
runs any script. Curves are normalised to each run's own first equity point so runs started
with different cash share an axis; that arithmetic lives in chart.ts, the one file the
one-rule guard exempts, and its export pin is updated in this commit."
```

---

### Task 2: `/universe` — the screener (its own PR)

**Files:**
- Create: `packages/dashboard/src/pages/universe.ts`, `packages/dashboard/test/universe.test.ts`, `packages/reports/test/priceChange.test.ts`
- Modify: `packages/reports/src/format.ts` + `index.ts` (`priceChangePct`), `packages/dashboard/src/reads.ts` (three queries), `packages/dashboard/test/reads.pg.test.ts`, `packages/dashboard/src/server.ts` (route + deps), `packages/cli/src/commands/dashboard.ts` (wire the deps), `packages/dashboard/test/server.test.ts`

**Interfaces:**
- Produces, in `@ctb/reports`:
  ```ts
  /** Percent change between two decimal-string prices, to two places; null when `then` is absent,
   * unparseable or zero — there is no percentage of nothing, and rendering 0 there would read as
   * "unchanged" when the truth is "unknown". */
  export function priceChangePct(then: string | null | undefined, now: string | null | undefined): number | null;
  ```
  It lives here, not in the dashboard, because the dashboard may not compute a percentage (the one rule). It uses `Number()` on the decimal strings — display precision, the same boundary `chart.ts` accepts — and must not import `@ctb/candles`, which would break the purity guard.
- Produces, in `reads.ts` (all `SELECT`, all bounded, all invocable with generic-safe arguments so the read-only guard can drive them):
  ```ts
  export interface TokenSnapshot { unit: string; dex: string; poolId: string; tickTs: Date; reserveBase: bigint; reserveQuote: bigint; feeBps: number; tvlLovelace: bigint }
  export interface ExternalCoverage { unit: string; rows: number; first: Date | null; last: Date | null }
  // on DashboardReads and PgDashboardReads:
  latestSnapshotsPerToken(): Promise<TokenSnapshot[]>;   // the deepest pool per token AT the newest tick_ts
  snapshotsAt(at: Date, withinMs: number): Promise<TokenSnapshot[]>;  // the deepest pool per token at the newest tick <= `at` and no older than `at - withinMs`
  externalCoverageAll(): Promise<ExternalCoverage[]>;    // one row per unit that has an external_pool_map entry
  ```
  "Deepest" means largest `reserve_quote`, ties broken by smallest `pool_id`, matching how the collector and `buildCandles` choose. Use `DISTINCT ON (base_unit) … ORDER BY base_unit, reserve_quote DESC, pool_id` — one query, no N+1.
- Produces, in `pages/universe.ts`:
  ```ts
  export const UNIVERSE_SORTS = ['rank', 'ticker', 'depth', 'change', 'coverage'] as const;
  export function renderUniverse(input: {
    tokens: TokenSpec[];                      // universe order == market-cap rank
    latest: TokenSnapshot[]; dayAgo: TokenSnapshot[]; coverage: ExternalCoverage[];
    sort: (typeof UNIVERSE_SORTS)[number]; now: Date;
  }): string;
  ```

- [ ] **Step 1: `priceChangePct` with tests**

```ts
export function priceChangePct(then: string | null | undefined, now: string | null | undefined): number | null {
  if (then === null || then === undefined || now === null || now === undefined) return null;
  const a = Number(then);
  const b = Number(now);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return Math.round(((b - a) / a) * 10_000) / 100;
}
```
Tests: a doubling is 100; a halving is -50; equal prices are 0 (not null — unchanged is a fact); a zero, empty, absent or unparseable `then` is null; a very small decimal string still yields a finite number; rounding is to two places.

- [ ] **Step 2: The three reads, with a Postgres test**

`reads.pg.test.ts` gains a fixture with three tokens: one with two pools at the newest tick (proving the deepest wins and the ties rule), one whose only snapshot is older than the newest tick (proving it is absent from `latestSnapshotsPerToken`), and one with external coverage and one without. Assert `snapshotsAt` returns the row at or before the target and nothing older than the window, and that a target before any snapshot returns an empty array. Every table the test creates is dropped by `withTestSchema`'s own `DROP SCHEMA … CASCADE`; do not create anything outside the throwaway schema.

- [ ] **Step 3: `renderUniverse` with tests**

One row per universe token, in universe order by default. Columns: rank (array position + 1 — an index, allowlisted arithmetic; if the guard objects, render the position from a pre-built list rather than widening the allowlist), ticker, venue, pool id (shortened to first 12 characters, full value in a `title` attribute), ADA depth via `adaStr(reserveQuote)`, price via `priceAdaPerToken(reserveQuote, reserveBase, decimals)` from `@ctb/candles`, 24-hour change via `priceChangePct`, external rows / first / last, and a link to `/runs?ticker=<ticker>`.
A token with no row in `latest` renders `-` in every measured column and a note that the collector has no snapshot for it on the newest tick. A token with no `dayAgo` row renders `-` for change. A token with no coverage row renders `0` rows and `-` dates.
`?sort=` reorders server-side: `ticker` alphabetical; `depth` and `change` descending with absent values last (never treated as zero, never floating to the top); `coverage` by row count descending; `rank` is the default. An unknown sort value is a 400 naming the accepted ones.
Above the table, one line stating what the numbers are: the newest collector tick's timestamp, that depth and price come from the deepest pool per token at that tick, and that the change compares against the newest tick at or before 24 hours ago.

- [ ] **Step 4: Route and wiring**

`GET /universe` reads `?sort=`, calls the three reads plus `loadUniverse`'s tokens (already available via a dep — add `universeTokens: () => TokenSpec[]` to `DashboardDeps` and wire it in `commands/dashboard.ts`, the same shape as `tickers`). The 24-hour target is `now - 24h` with a window of `withinMs = 26h`, so a gap in collection degrades to the nearest older tick rather than to nothing; state that in the page's explanatory line. Add `/universe` to the smoke test's route list and to its "no secret in any body" case.

- [ ] **Step 5: Verify**

`npm run lint`, `npm test`, `npm run test:pg`, then live on a spare port as in Task 1:
- `/universe` lists 20 rows; MinswapV2 is the venue for every token (it is the deepest for all 20 today); depth and price are non-empty for the tokens on the newest tick.
- `/universe?sort=depth` orders by depth descending; `?sort=change` puts tokens with no 24-hour-ago snapshot LAST, not first; `?sort=bogus` returns 400.
- Cross-check one token's depth against the database directly with a read-only query, and its price against `priceAdaPerToken` computed by hand from the same reserves.
- Confirm SONG and USDM (no usable external history) render `0` rows and `-` dates rather than a blank or a crash.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(dashboard): /universe — the 20 tokens with deepest pool, depth, price, 24h change and external coverage

priceChangePct lives in @ctb/reports because the dashboard may not compute a percentage.
An absent snapshot renders '-' and sorts last; it is never treated as zero."
```

---

### Task 3: Acceptance, docs, and the spec's open question (its own PR)

**Files:**
- Modify: `docs/ops/RUNBOOK-dashboard.md`, `docs/specs/2026-09-07-m4-dashboard.md` (§8 milestone rows, §10 open questions)

- [ ] **Step 1:** Extend the runbook's "what each page shows" with `/compare` (how to select runs, that order is the operator's and nothing is sorted by return, and that a backtest contributes no curve because backtests persist no equity) and `/universe` (what the numbers are measured from, and that `-` means unknown rather than zero).
- [ ] **Step 2:** Answer the spec's §10 open question in the spec itself: the 24-hour change reads the newest snapshot at or before 24 hours ago, within a 26-hour window, because it is the same source as the current price and therefore comparable; candles are built from those same snapshots, so reading them instead would add a layer without adding information. Mark M4b and M4c done in §8 with the date.
- [ ] **Step 3:** Note in the runbook that the health page still does not carry `status --digest`'s trailing sections (the per-venue table, the missing-ticks line, and the running-paper-runs line), so an operator switching their morning check to the browser should keep running `status --digest` while a paper run is live.
- [ ] **Step 4: Commit** `docs(ops): /compare and /universe in the dashboard runbook; answer the spec's 24h-change question; M4b and M4c done`.

M4b + M4c are done when: `/compare` and `/universe` serve, their guards and tests are green in CI, the compare table matches `report --compare` for the same ids, and the runbook describes both pages truthfully.

## Self-review

- Spec coverage: §4.2 `/compare` → Task 1; §4.2 `/universe` → Task 2; §4.3's three reads → Task 2 Step 2 (`runsSharingGrid` is deliberately NOT built — explicit checkbox selection replaces the heuristic, and the spec's §4.2 sentence about batch links is answered by it; say so in Task 3); §3 boundaries → Global Constraints; §6 errors → the 400/404 cases in Tasks 1 and 2; §8 → Task 3; §10 → Task 3 Step 2.
- Placeholders: none; every step names its files, its assertions and its live checks.
- Type consistency: `CompareRunInput` is imported from `@ctb/reports`, not redeclared; `TokenSnapshot`/`ExternalCoverage` are declared in `reads.ts` in Task 2 before `pages/universe.ts` uses them; `NormalisedSeries` is declared in `chart.ts` in Task 1 Step 1 before Step 3 uses it; `universeTokens` is added to `DashboardDeps` in Task 2 Step 4, the only task that needs it.
- Known risk carried from M4a: the one-rule guard pins provenance, not placement. Both new pages add columns, so each page's test must pin at least one cell to its source value, as `runs.test.ts` now does.
