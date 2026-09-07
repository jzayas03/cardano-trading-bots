# Runbook: the dashboard (M4a)

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

If it has already been applied (this is idempotent — the role is only created `IF NOT EXISTS`, and a
schema can be migrated more than once safely), it instead prints `schema already current` and does
nothing.

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

- **`/` Health.** The same lines `status --digest` prints — collector tick freshness, quota pace,
  any venue lost since the last discovery — rendered as a status board instead of terminal text,
  plus `doctor`'s own process, migration and rehearsal-data checks below them. Refreshes itself every
  60 seconds so it is safe to leave open. A database error renders an error page rather than a stale
  or partial board.
- **`/runs`.** Every run, newest first, 50 to a page. Filter by mode, strategy, ticker or status
  with query parameters; an unrecognized filter value is a 400 naming what is accepted, never a
  silent "show everything." Each row carries the same return, drawdown, fill counts and warning
  count `report` would print for that run, and a `REHEARSAL` marker for any run made with synthetic
  data.
- **`/runs/:id`.** One run's own page: its provenance (git sha, mode, data source, window, fill
  model, strategy params), the coverage and feed-counter lines, every warning, the headline numbers,
  an equity chart for paper runs, and the orders table. A rehearsal run shows the
  `REHEARSAL — synthetic data — not evidence` banner at the top.

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
already use. Two guard tests in `packages/dashboard/test` pin this: one greps the dashboard package
for any arithmetic of its own (a `returnPct`, `maxDrawdown`, `/ 1_000_000`, or similar assignment that
is not an import), and the other runs every handler against a database stand-in that fails on any
query that is not `SELECT`/`WITH`.

That means the health page and `status --digest` cannot legitimately show different numbers for the
same collector state, and neither can a run's `/runs/:id` page and `report <id>` for the same run —
they call the exact same code. **If you ever see them disagree, that is a bug in this rule, not a
data problem to reconcile by hand.** File it and go look at what changed in `@ctb/reports` or in
which function a page calls, rather than trusting whichever number looks more plausible.

M4a is done when the operator has opened the health page in the morning once instead of running
`status --digest`, and the two agreed.
