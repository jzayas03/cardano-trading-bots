# M4: local read-only dashboard

Date: 2026-09-07. Status: approved design, pre-implementation.
Builds on: `docs/specs/2026-09-05-paper-trading-foundation.md` (M0-M3).

## 1. Purpose

See the database without a terminal: is the collector alive and inside its
quota, what does the universe look like today, what did every backtest and
paper run do, and how do several runs compare. Read only, on this Mac, for one
person. No trading controls of any kind.

Success means: after M4 the operator opens `http://127.0.0.1:3210/` in the
morning instead of running `status --digest`, clicks into any run and sees the
same numbers `report <id>` prints, and compares runs on one chart without
copying ids into a terminal.

## 2. Decisions already made

| Decision | Choice | Why |
| --- | --- | --- |
| Audience | Only the operator, on this Mac | No login, no exposure, nothing to secure beyond the localhost bind |
| Shape | Small Node HTTP server, server-rendered HTML, one new package | No second toolchain, no build step, same `tsx` runtime and test style as the CLI |
| Charts | uPlot, vendored into the package and served from it | One small file, works offline, no CDN, no runtime dependency tree |
| Numbers | Only the CLI's own pure functions | A page and its CLI report can never disagree (see §4) |
| Data access | The existing repos plus one read-only query module | Nothing the CLI does not already read is read here |
| Refresh | `<meta http-equiv="refresh">` on the health page, URL query parameters for sorting and selection | The URL is the state; no client-side state to lose |

Rejected: React + Vite SPA with a JSON API (a second toolchain for a
single-user local tool; reconsider if operator controls ever arrive), static
export with no server (no live health page, no interactive compare), any
remote or shared deployment (M5 candidate, its own spec).

## 3. Boundaries

- Read only. The dashboard's database role has `SELECT` only; a test proves no
  handler issues anything else. There is no button that starts, stops, resumes
  or configures anything.
- Bound to `127.0.0.1`. The bind address is not configurable in this spec.
- Secrets never rendered. The health page reports the Blockfrost key by length
  only, exactly as `doctor` does; a smoke test asserts no page body contains
  the key, the database password, or any `.env` value.
- Synthetic data can never be mistaken for real: a rehearsal run carries the
  REHEARSAL banner on every page that shows it, from the persisted `rehearsal`
  flag, and a `Fake` venue is labelled wherever a venue is shown.
- Strategy profitability stays the operator's judgement. Tables are never
  sorted by return unless the operator clicks that column; the default order
  is the order the runs were created.

## 4. Package: `packages/dashboard`

```
packages/dashboard/
  src/server.ts        createServer(deps) -> http.Server; route table; error page
  src/reads.ts         DashboardReads: the SELECT-only queries the repos lack
  src/pages/health.ts  renderHealth(input) -> html
  src/pages/universe.ts
  src/pages/runs.ts    list + detail
  src/pages/compare.ts
  src/html.ts          escape(), layout(), table(), banner()
  src/chart.ts         equity series -> uPlot data + the inline init script
  vendor/uplot.min.js, vendor/uplot.min.css   (pinned version, checked in)
  test/*.test.ts       renderers on fixtures; server smoke; reads.pg.test.ts
```

CLI: `npm run dashboard [--port 3210]` in `packages/cli` starts it and prints
the URL. `doctor` gains one informational line: whether a dashboard is running.

### 4.1 The one rule for every number

Every figure on every page comes from a function the CLI already uses:

| Page | Functions |
| --- | --- |
| Health | `digestLines`, `checkProcesses`, `checkMigrations`, `checkFakeRows` |
| Universe | the snapshot rows as stored; `adaStr` |
| Run detail | `summarizeRun`, `coverageLine`, `feedCountersLine`, `assumedVenuesTouched`, `adaStr` |
| Compare | `compareRunRows`, `sweepRows`, `gridRows` |

The dashboard package defines no summarizer, no return, drawdown or fee
arithmetic, and no coverage arithmetic of its own. A guard test parses every
source file's TypeScript AST (`ts.createSourceFile`) and fails on any binary
arithmetic expression between two non-constant operands, anywhere in the
package outside the one file this spec sanctions for the lovelace-to-float
chart conversion — a real parser, not a grep or regex over source text, so
it is not defeated by a comment, a string/template literal, unusual spacing,
or a multi-line expression the way an earlier, since-replaced text-based
version of this guard was (M4a final review; see the guard's own header
comment for the round-by-round history). This rule is about PROVENANCE —
that a number came from `@ctb/reports` — not about PLACEMENT: it does not
and cannot catch two columns being swapped with each other on the same page,
since both numbers still satisfy the rule. A separate, narrower test pins
column position. The functions it needs that live in `packages/cli` today
(`digestLines`, the doctor checks, the compare and grid row builders,
`adaStr`) move to a new `@ctb/reports` package in M4a so neither the CLI nor
the dashboard imports the other.

### 4.2 Pages

**`/` Health.** The digest as a status board: each digest line as a row with
the same OK / WATCH / STOP / STALE / LOST words, coloured only by those words.
Below it the doctor's process, migration and rehearsal-data checks. Refreshes
every 60 s. A database error renders the error page (§6), never a stale board.

**`/universe` Screener.** One row per universe token: ticker, deepest pool's
venue and ADA depth from the newest snapshot tick, price at that tick, 24 h
change computed from the snapshot 24 h earlier (or "-" when absent), venues
present, external-history coverage (rows, first, last) and a link to
`/runs?ticker=X`. Sorted by market-cap rank from `universe.json` by default;
`?sort=depth|change|coverage` re-sorts server-side.

**`/runs`.** Every run, newest first, filterable by `?mode=`, `?strategy=`,
`?ticker=`, `?status=`. Columns: id, mode, strategy, ticker, status, created,
return, max drawdown, fills / intents, warnings count, REHEARSAL, basis.
Return and drawdown come from `runs.summary` for EVERY mode — backtest and
paper alike — never from a per-row query over that run's equity/orders,
because the list must stay one query for a page of 50 runs (M4a final
review: the option of recomputing paper rows via `summarizeRun` over
persisted rows, as an earlier draft of this section described, was
deliberately not taken here — it belongs on the detail page instead, per
below). `runs.summary` is written once, by the engine, at the end of a
segment; for a run with no resume that IS the whole run, but for a resumed
paper run it reflects only the LAST segment. `basis` names which case this
row is in: `summary`, `summary (last segment)`, or `unfinished`. Checkboxes
and a "compare selected" button that only builds the `/compare` URL.

**`/runs/:id`.** The provenance block first (git sha, mode, source, window,
fill model, params with cost basis per venue, grid or sweep membership when
present), then status lines for paper runs, the coverage line, every warning,
the headline table(s), the equity chart for paper runs with at least two
persisted points (all persisted points; a chart page loads uPlot's script
and stylesheet, a non-chart page loads neither), the reject-reasons table,
and the orders table with the same columns as the CLI, paginated at 200
rows. A backtest shows "equity is not persisted for backtest runs" where the
chart would be. **For a paper run, "the headline table(s)" is TWO tables**
(M4a final review, CRITICAL 1): the whole-run headline recomputed from every
persisted equity point and order across every segment via `summarizeRun`,
and — right below it, when the run has finished at least one segment — the
same `runs.summary` table `/runs`'s `basis` column reads from, under a
heading naming it the last segment only and how many resumes it is missing.
Both are shown, always in that order, so the number `/runs` showed for this
run is always findable on the page it links to.

**`/compare?ids=14,15,16`.** `compareRunRows` as a table, then one uPlot chart
with every selected paper run's equity as a percentage of its own start so
runs of different cash sizes share an axis. Mixed tokens get the same warning
line the CLI prints. Runs that share a `params.grid` or a sweep window can be
selected together from `/runs` with one click on their batch link.

### 4.3 Data access

`DashboardReads` (SELECT only) adds: `listRuns(filter, limit, offset)`,
`latestSnapshotsPerToken()`, `snapshotAt(unit, tick)`, `externalCoverageAll()`,
`runsSharingGrid(runId)`. Everything else goes through `PgRunRepo`,
`PgCandleRepo`, `PgExternalRepo` and `loadDigestInput` unchanged. Every query
is scoped and bounded; no page issues a query without a `LIMIT` except the
digest's own aggregates.

## 5. Data model

No schema change. One migration adds the read-only role
`ctb_dashboard` with `SELECT` on every table and the `search_path`; the
dashboard connects as that role via `DASHBOARD_DATABASE_URL`, defaulting to
the same host and database as `DATABASE_URL` with that user. Its password is
local-only like `ctb_local_only` and lives in `.env.example` as such.

## 6. Error handling

- Database unreachable or a query failing: an error page with the message and
  the route, HTTP 500, logged once at error level. Never a partial table.
- Unknown run id: 404 page naming the id.
- A run with no summary: "unfinished" where the headline would be, as the CLI
  prints. Fewer than two equity points: the table without the chart.
- Bad query parameters (a non-integer id, an unknown sort key): 400 with the
  accepted values, never a silent default.
- The server never exits on a handler error; a handler that throws renders
  the error page for that request only.

## 7. Testing

- Renderers: pure functions from fixtures to HTML, asserted on text content
  and on the absence of secrets, the way `report.test.ts` spies on
  `console.table`. Every page has a fixture for the empty state, the normal
  state and the REHEARSAL state.
- `reads.pg.test.ts`: every `DashboardReads` query against the throwaway
  schema, with a fixture that has one paper run, one backtest, one grid and
  rows on both sides of the 24 h boundary.
- Server smoke: start on port 0, fetch every route (including a bad id and a
  bad sort), assert the status codes, `Content-Type`, and that no body
  contains any value from a fake `.env`.
- The read-only guard: a test that runs every handler against a `Queryable`
  which records SQL and fails on anything not starting with `SELECT` or
  `WITH`.
- The one-rule guard from §4.1.

## 8. Milestones

| Milestone | Done when |
| --- | --- |
| M4a | `@ctb/reports` extracted; `npm run dashboard` serves `/`, `/runs`, `/runs/:id`; smoke and read-only tests green; the operator's morning check is the health page |
| M4b | `/compare` with the shared equity chart; grid and sweep batches selectable from `/runs` |
| M4c | `/universe` screener with sort; `doctor` reports the dashboard |

Each milestone is its own plan under `docs/plans/` and its own PRs, executed
the way M1-M3 were.

## 9. Out of scope

Login or any remote access, writes of any kind, live-updating charts,
alerts or notifications, mobile layout work beyond a readable table, a
second theme. Deployment off the laptop is the M5 candidate.

## 10. Open questions

- uPlot's exact pinned version and size are checked at M4a; if it is over
  60 KB or its licence is not MIT, the fallback is an inline SVG polyline
  renderer with no library.
- Whether the 24 h change on the screener should read the snapshot 24 h back
  or the candle close: decided at M4c from what the collector's history looks
  like after a week.
