# Runbook: the dashboard (M4a-M4c)

A local, read-only web view of the same database `status` and `report` read: a health board, the
runs list, and a run's own page, all served from `http://127.0.0.1:3210/`. It costs nothing to run —
no Blockfrost calls, no writes — and it replaces `status --digest` as the morning check once it has
been run side by side with it once and the two agreed (see the bottom of this file). It complements
`docs/ops/RUNBOOK-collector.md` and `RUNBOOK-paper.md`, which are still where `collect` and `paper`
themselves are started and stopped; the dashboard only reads what they wrote.

## First-time setup: the one step that touches the database

Everything else in this file is read-only. This step is not: `npm run migrate` applies migration
`0006_dashboard_role.sql`, which creates a new Postgres role, `ctb_dashboard`, and grants it `SELECT`
on every table in the current schema (plus a default-privileges rule so tables added later are
covered automatically). Creating a role and granting it access to live data is a database change,
so run this only with the operator's own go-ahead — do not run it on their behalf.

```bash
npm run migrate
```

If `0006_dashboard_role.sql` is still pending, this prints a line naming it, e.g. (via the same pino
logger every command uses):

```
INFO: migrations applied {"applied":["0006_dashboard_role.sql"]}
```

If it has already been applied, it instead prints `schema already current` and does nothing — this is
idempotent, but not via a check-then-create: `CREATE ROLE` has no `IF NOT EXISTS` form, and a
check-then-create is not atomic across concurrent sessions (measured: 7 of 8 concurrent migrations,
each racing a fresh cluster, failed with a duplicate-role error that way). The migration instead tries
the `CREATE ROLE` unconditionally and catches the collision (`duplicate_object`/`unique_violation`) when
another session already created it — the standard idiom for "create this cluster-wide object exactly
once, however many sessions race to do it."

**Confirm the role is really read-only** before trusting anything else in this file. Connect as
`ctb_dashboard` directly and try a write — it must be refused:

```bash
psql "postgres://ctb_dashboard:ctb_dashboard_local_only@localhost:5433/ctb" -c "DELETE FROM runs WHERE id = -1;"
```

Expect `ERROR:  permission denied for table runs`. A `SELECT` against the same connection should
succeed normally. That single failed `DELETE` is the actual control — everything below describes an
application that is also careful, but the role refusing the write is what makes it true regardless of
what the code does.

The role's password (`ctb_dashboard_local_only`) is local-only in the same sense as the collector's
`ctb_local_only`: this Postgres is bound to `127.0.0.1` and holds no secret in that value. `DATABASE_URL`
runs `migrate`; `DASHBOARD_DATABASE_URL` is what the dashboard itself connects with (defaulted from
`DATABASE_URL` with the `ctb_dashboard` user if left unset — see `.env.example`).

## Start

```bash
npm run dashboard              # http://127.0.0.1:3210/
npm run dashboard -- --port 3300   # a different port, e.g. if 3210 is taken
```

It prints the URL to connect to and stays in the foreground:

```
dashboard: http://127.0.0.1:3210/ (read-only, localhost only; Ctrl-C to stop)
```

## Check

Open the printed URL. `/` is the health board; the other pages are described below. There is
nothing else to check from a terminal — the process either bound its port and is serving, or it
exited with an error (most commonly a bad or unreachable `DASHBOARD_DATABASE_URL`, printed to the
same log).

## Stop

Ctrl-C in the foreground terminal. The server closes its one HTTP listener and its database pool and
exits on its own; there is no state to flush and nothing to wait for.

## What each page shows

- **`/` Health.** The digest lines `status --digest` prints — collector tick freshness, quota pace,
  any venue lost since the last discovery — rendered as a status board instead of terminal text,
  plus `doctor`'s own process, migration and rehearsal-data checks below them. Below those: the same
  three sections `status --digest` prints after the digest lines, from the exact same repository
  calls — a per-venue pool-count table at the newest tick, the `ticks missing in last 24h (approx)`
  line, and the paper runs table (id, strategy, ticker, rehearsal, heartbeat age, last tick, created;
  `(none running)` when nothing is). Refreshes itself every 60 seconds so it is safe to leave open. A
  database error renders an error page rather than a stale or partial board. This page now carries
  everything `status --digest` prints — an operator can make this their morning check without also
  running the command.
- **`/runs`.** Every run, newest first, 50 to a page. Filter by mode, strategy, ticker or status
  with query parameters; an unrecognized filter value is a 400 naming what is accepted, never a
  silent "show everything." Each row's return %, max DD %, and fill counts come from `runs.summary` —
  the row the engine wrote once, at finish time — never from a fresh query over that run's own rows
  (the list would stop being one query per page otherwise). For a run with no resume this IS the whole
  run. For a **resumed** paper run, `runs.summary` reflects only the LAST segment that wrote it, not
  the whole run — the `basis` column reads `summary (last segment)` for exactly this case, and
  `/runs/:id` for the same run shows the full picture: the whole-run headline (from every persisted
  row across every segment) AND this same `runs.summary` table, side by side, so the two numbers are
  never on different pages with no way to tell which is which.
- **`/runs/:id`.** One run's own page: its provenance (git sha, mode, data source, window, fill
  model, strategy params), the coverage and feed-counter lines, every warning, the headline numbers —
  for a paper run, BOTH the whole-run persisted-rows headline and, right below it, the same
  `runs.summary` table `/runs`'s `basis` column is reading from, under the identical heading `report
  <id>` prints — an equity chart for paper runs with at least two persisted equity points, and the
  orders table. A rehearsal run shows the `REHEARSAL — synthetic data — not evidence` banner at the
  top.
- **`/compare?ids=…`.** Several runs side by side: one table of their headlines and one chart with
  their equity curves. Reach it by ticking boxes on `/runs` and pressing "compare selected", or by
  typing the ids yourself — `?ids=6,7` and `?ids=6&ids=7` both work. The order is the order you asked
  for; nothing is ever sorted by return. At most twelve runs at a time, because a chart with more
  lines than that cannot be read. A backtest contributes a row but no curve: backtests persist orders
  and a summary, not an equity point per candle, so there is nothing to plot. Curves are drawn as a
  percentage of each run's own starting equity, so a run started with 1,000 ADA and one started with
  10,000 sit on the same axis.

  **A run's number here can differ from the same run's number on `/runs`, and that is not a bug.**
  `/compare` recomputes a paper run's headline from every persisted row across every segment; `/runs`
  reads the stored `runs.summary`. For a resumed run those are different figures — the whole run
  versus its last segment — and each surface labels which it is showing in its `basis` column. The
  standing instruction below, to file a bug when two surfaces disagree, means two surfaces claiming
  the SAME basis and disagreeing. Two surfaces declaring different bases and showing different numbers
  is them working.
- **`/universe`.** The 20 tokens the bot follows: the deepest pool for each on the collector's newest
  tick, its venue, ADA depth, price, 24-hour change and how much external price history has been
  backfilled. Sort with `?sort=rank|ticker|depth|change|coverage`; the default is market-cap rank as
  seeded in `universe.json`. Depth and price are measured from that one deepest pool at that one tick,
  and the price is the same figure the candle builder records. The 24-hour change compares against the
  newest tick at or before 24 hours ago, falling back to a tick up to 26 hours old if collection
  gapped; hover the change cell to see which tick a row actually used. **A dash means unknown, never
  zero** — no snapshot on the newest tick, no baseline old enough, or no external history — and under
  any sort those rows go last rather than to the top.

## What it can never do

- **No writes of any kind.** Not "the application is careful about it" — the database role it
  connects as has `SELECT` only, so even a bug that tried to write would be refused by Postgres
  itself before it reached a table. That is the control; the first-time-setup check above is how you
  see it work.
- **Localhost only.** The server binds `127.0.0.1` and that address is not a setting — there is no
  flag or environment variable that changes it. It cannot be reached from another machine on the
  network, let alone the internet.
- **No login.** There is nothing to log into, because there is no way to reach this server except
  from a browser running on the same Mac. A login screen would be a control for a threat this
  dashboard does not have.

## Known limitation: `ctb_dashboard` can create a temporary table

`SELECT`-only was the grant migration 0006 gave the role explicitly, but Postgres also grants
`CREATE` on `TEMPORARY` tables to the built-in `PUBLIC` role at the database level by default — every
role gets it unless someone revokes it. `ctb_dashboard` is no exception, so a session connected as it
technically can run `CREATE TEMP TABLE`. Removing that would mean revoking `TEMPORARY` from `PUBLIC`
on the whole database and re-granting it specifically to the collector's own role (the one thing here
that legitimately needs it), which is a database-wide change with a bigger blast radius than the risk
it removes. It is left as-is deliberately: a temporary table is private to the session that created
it, disappears when that session ends, and cannot read or alter a single real row — so the worst it
enables is a connection wasting a little of its own memory, not a data leak or a write to anything
that matters.

## The rule that makes this trustworthy

Every number on every page is the return value of a function from `@ctb/reports` — the same package
and, for a given run or digest, the same function call `report <id>`, `status --digest`, and `doctor`
already use. Two guard tests in `packages/dashboard/test` pin this: one parses every source file's
TypeScript AST (`ts.createSourceFile`, not a grep or regex over the text) and fails on any binary
arithmetic expression between two non-constant operands outside the one file spec sanctions for the
lovelace-to-float conversion (`chart.ts`, whose own exported surface is separately pinned) — a real
parser sees past comments, string/template contents, and formatting the way a regex cannot, which is
why this guard was rewritten onto it after two earlier text-based versions each left a bypass. The
other runs every handler against a database stand-in that fails on any query that is not
`SELECT`/`WITH`. **This rule is about provenance — where a number comes FROM — not about placement —
where it lands on the page.** It would not catch, and does not try to catch, two of a page's own
columns being swapped with each other: both numbers still came from `@ctb/reports`/`runs.summary`,
satisfying the rule, while displaying under each other's label. Placement is a separate, narrower pin
in `packages/dashboard/test/runs.test.ts` that reads each column's own cell by position.

That means the health page and `status --digest` cannot legitimately show different numbers for the
same collector state, and neither can a run's `/runs/:id` page and `report <id>` for the same run —
they call the exact same code. **If you ever see them disagree, that is a bug in this rule, not a
data problem to reconcile by hand.** File it and go look at what changed in `@ctb/reports` or in
which function a page calls, rather than trusting whichever number looks more plausible.

M4a/M4b/M4c are done when the operator has opened the health page in the morning once instead of
running `status --digest`, and the two agreed.
