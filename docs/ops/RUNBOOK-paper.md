# Runbook: `paper` mode

Operating a live paper run: start, check, stop, resume, recover from a crash, clean up.
Written for M3; the acceptance drill itself is Task 7 of `docs/plans/2026-09-06-m3-paper-mode.md`.

The paper process builds its own candles each boundary. It does **not** depend on a `candles` cron,
but it does depend on `collect` running: without snapshots there is nothing to build from. The
dashboard's `/runs/:id` page (`docs/ops/RUNBOOK-dashboard.md`) shows the same headline `report <id>`
prints below — `report` has no equity chart of its own, so the chart is something this page gives you
that the terminal command cannot — and its health page is the morning check for whether this run's
feed is still alive.

`collect` defaults to a 600s interval, `COLLECT_REFRESH=deepest` (one pool per token), and 6 venues
(see `.env.example` for the refresh-budget arithmetic) — `paper` inherits the 600s interval from
`COLLECT_INTERVAL_SECONDS` (below) automatically.

## Before anything: `npm run doctor`

Node version, `.env` (key present by length only, interval vs default), database and migrations,
duplicate collector/paper processes, rehearsal leftovers, disk, and the digest's collector/quota
lines. Exit code 1 on any FAIL. Two of tonight's incidents (2026-09-07: a duplicate collector, a
stale `COLLECT_INTERVAL_SECONDS=300`) are checks here now.

## Start

```bash
set -a && source .env && set +a
caffeinate -is npm run paper -- ma-crossover SNEK > paper.log 2>&1 &
echo $! > paper.pid
```

`--interval-sec` defaults to `COLLECT_INTERVAL_SECONDS` and **refuses** a value that differs from
it: the paper clock sleeps to its own boundaries and then reads candles bucketed at the collector's,
so a mismatch puts every boundary where no snapshot exists — a run that heartbeats forever and
yields nothing. Pass `--allow-interval-mismatch` only if that is deliberate.

`paper.pid` holds the **wrapper's** pid. `kill -INT` the real `node` process:

```bash
pgrep -fl 'main.ts paper'
```

## Several strategies at once

Run one `paper` process per strategy. They share the collector's snapshots, each builds candles at the
boundary (idempotent, database-only, no Blockfrost cost), and each has its own run row, heartbeat and
report. Give each its own log and pid file:

```bash
caffeinate -is npm run paper -- ma-crossover SNEK > paper-ma.log 2>&1 &
caffeinate -is npm run paper -- rsi-mean-reversion SNEK > paper-rsi.log 2>&1 &
caffeinate -is npm run paper -- buy-and-hold SNEK > paper-bah.log 2>&1 &
```

`npm run status` lists them together. Compare them from their persisted rows at any time, in the
order you list them (never sorted by return, so the table cannot read as a ranking):

```bash
npm run report -- --compare 14,15,16
```

A rehearsal run anywhere in the list puts the REHEARSAL banner above the table and the word on its row.

## Check

```bash
npm run status                      # heartbeat age per running run; STALE (Ns) once past the bound
npm run report -- <run-id>          # headline over ALL persisted rows, plus the last segment's own
npm run report -- <run-id> --day $(date -u -v-1d +%F)
```

- **heartbeat age** is `STALE` past `2 * intervalSec + graceSec`. One missed beat is jitter; two is
  something to look at.
- **`feed:` line** — `ticks / built / yielded / stale-skipped / empty / failed`. `yielded 0` with a
  climbing `empty` count is a dead collector seen from inside the paper process. Cross-reference
  `collector_runs` for the same hour.
- **`summary (from persisted rows)`** counts every segment. The `last segment summary` below it is
  `runs.summary`, which only ever describes the segment whose process wrote it — on a resumed run
  the two differ, and that is expected, not a bug.

## Stop

```bash
kill -INT <node-pid>
```

The run finishes the candle in flight, records `status = 'finished'`, `stop_reason = 'signal'`, and
prints its report. Intents decided on the last candle never got a `t+1` to settle against and are
recorded `rejected: stopped` — they are **not** re-decided on resume.

## Resume

```bash
npm run paper -- ma-crossover SNEK --resume <run-id>
```

Cash, position and `paper_orders.seq` are restored from the run, and the strategy's indicator window
is primed from candles at or before the resume point, so it can trade on the first boundary rather
than after another `warmup` of them. Strategy params must match the ones the run started with.
`--cash-ada` is refused: the balance comes from the run.

## Crash recovery (the process died without stopping cleanly)

A `kill -9`, an OOM kill, or a lost machine never reaches the code that records a stop, so the row
stays `status = 'running'` forever.

1. **Confirm nothing is still running.** Two writers on one `run_id` would race `paper_orders.seq`.
   ```bash
   pgrep -fl 'main.ts paper'          # must be empty
   npm run status                     # the run's heartbeat age must read STALE (Ns)
   ```
2. **Resume it.** `--resume` accepts a `running` row *once its heartbeat is stale* — that is the
   recovery path, not a bug. It logs `resuming a run whose heartbeat is stale (age Ns)` and records
   the same sentence as a warning on the run.
   ```bash
   npm run paper -- ma-crossover SNEK --resume <run-id>
   ```
   A run whose heartbeat is still **fresh** is refused, because a live process is probably writing it.
3. **Check what was lost.** At most the in-flight intents of one candle. Each candle's orders and its
   equity point are written in one transaction, so there is never a fill without its equity point.
   ```sql
   SELECT max(seq) FROM paper_orders WHERE run_id = <id>;
   SELECT max(tick_ts) FROM run_equity WHERE run_id = <id>;
   ```

If the run stopped itself with `stop_reason = 'feed failing: …'`, it hit
`--max-tick-failures` (default 12) consecutive failing boundaries. Fix the cause — usually the
collector or the database — before resuming; resuming into the same broken feed just aborts again.

## Rehearsal (synthetic data)

`dev:fake-collector` and `paper --rehearsal` both require `CTB_ALLOW_FAKE_DATA=1` **and** a
localhost database. Every such run carries `runs.rehearsal = true` and every report of it opens with
`REHEARSAL — synthetic data — not evidence`.

A non-rehearsal `paper` refuses to start while **any** `Fake` row exists for the token, in either
table and of any age:

```sql
SELECT count(*) FROM pool_snapshots WHERE dex = 'Fake';
SELECT count(*) FROM candles WHERE pool_id LIKE 'Fake:%';
```

## Cleanup after a rehearsal

Stop every process first — a running fake collector re-creates rows behind you.

```bash
pgrep -fl 'main.ts paper|main.ts dev:fake-collector'   # must be empty
psql "$DATABASE_URL" -c "DELETE FROM pool_snapshots WHERE dex = 'Fake';"
psql "$DATABASE_URL" -c "DELETE FROM candles WHERE pool_id LIKE 'Fake:%';"
psql "$DATABASE_URL" -c "SELECT count(*) FROM pool_snapshots WHERE dex = 'Fake';"   -- must be 0
psql "$DATABASE_URL" -c "SELECT count(*) FROM candles WHERE pool_id LIKE 'Fake:%';" -- must be 0
```

Leave the `runs`, `run_equity` and `paper_orders` rows in place. They are marked `rehearsal = true`
and every report of them says so; deleting them would remove the evidence the rehearsal happened.

**Never run cleanup from a backgrounded multi-step script.** Task 6's rehearsal lost
`pool_snapshots` and `candles` mid-run that way, when a backgrounded script reached its own cleanup
step while a second session was still running. Run each step in the foreground and read its output.
