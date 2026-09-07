# Runbook: the 7-day paper run (M3 acceptance)

The mechanics of one paper process — start, check, stop, resume, crash recovery, rehearsal
cleanup — are in `RUNBOOK-paper.md`. This file is the **campaign**: what has to be true before a
week-long run starts, what to do each day, when to abandon it, and what to produce at the end.
It supersedes the step list in `docs/plans/2026-09-06-m3-paper-mode.md` Task 7, which was written
before there were three strategies, a dashboard, or the failures of 2026-09-07.

The acceptance bar is spec §8 M3: *`paper` has run for 7 days; daily report cites run id, git sha,
fills, costs.*

## What it costs

- **No Blockfrost quota.** Paper mode loads its config with Blockfrost explicitly disabled and reads
  candles from Postgres; it never calls the chain. The collector's own usage (roughly 29,000 calls a
  day against the free 50,000) is unchanged by running three paper processes beside it.
- **About 2 MB of database a day** at the current 600-second interval (2,444 snapshots a day,
  measured 2026-09-07), so a week adds something like 15 MB to a 66 MB database. Not a constraint.
- **One terminal and about a minute a day of attention.**

## Before it starts

Every line below is a precondition, not a suggestion. Record each one's output in the M3 report.

1. **`npm run doctor` says OK.** This is the gate, and it exists because of two failures on
   2026-09-07: a collector started twice 36 seconds apart, and a stale `COLLECT_INTERVAL_SECONDS=300`
   in `.env` silently overriding the 600-second default. Both would have quietly corrupted a week.
   A FAIL here stops the run; a warning gets read and understood before you continue.
2. **The M1 report is merged** — 24 hours of `collector_runs` with the gaps explained.
3. **`npm run test:live` is green** on the dependencies you are about to run for a week. It costs
   about 1,100 Blockfrost calls, so run it when the day's budget allows, not during a discovery tick.
4. **Real candles exist.** First built 2026-09-07 — 2,265 across all 20 tokens; see
   `docs/ops/2026-09-07-first-real-candles.md`, which also carries the price-movement table this
   run's token should be chosen from, and the finding that a venue outage splices a token's series
   across pools.
   ```sql
   SELECT count(*), min(tick_ts), max(tick_ts) FROM candles WHERE pool_id NOT LIKE 'Fake:%';
   ```
5. **One `--source candles` backtest has run and been read.** Done: runs 129-136 on 2026-09-07,
   written up in the note above. This is the first time the
   observed-reserve fill path meets real data; every earlier backtest used the synthetic model over
   external history. If that run looks wrong, the week-long run would only produce more of the same.
6. **No rehearsal data.** `doctor`'s `rehearsal data` check covers this; a non-rehearsal paper run
   also refuses to start while any `Fake` row exists for its token.

## Starting

Three strategies, one process each, so they can be compared at the end. They share the collector's
snapshots and each builds its own candles at the boundary, which is database work, not chain work.

```bash
cd ~/code/cardano-trading-bots && set -a && source .env && set +a
caffeinate -is npm run paper -- ma-crossover SNEK       > paper-ma.log  2>&1 &
caffeinate -is npm run paper -- rsi-mean-reversion SNEK > paper-rsi.log 2>&1 &
caffeinate -is npm run paper -- buy-and-hold SNEK       > paper-bah.log 2>&1 &
sleep 5; pgrep -fl 'tsx packages/cli/src/main.ts paper' | wc -l   # must print 3
```

Write down the three run ids it prints. Do not rely on the pid files: `$!` captures the `caffeinate`
wrapper, not the process you need to signal. Everything in this repo stops a process by name.

## The daily check

Open `http://127.0.0.1:3210/` (`npm run dashboard` if it is not already up) and read two pages:

- **`/`** — the collector's tick freshness and quota verdict, and the `paper runs` table with each
  run's heartbeat age. Three rows, none STALE, is the whole check.
- **`/compare?ids=<the three ids>`** — the three equity curves on one chart and their headlines in
  one table.

The terminal equivalent, if you prefer it, is `npm run status` and
`npm run report -- <id> --day $(date -u -v-1d +%F)` for each run. Paste yesterday's day report for
each of the three into the M3 report as you go; a week reconstructed at the end from memory is not
the same artifact.

What to look at rather than glance past: the `feed:` counters on each run. A climbing `empty` count
with `yielded 0` is a dead collector seen from inside a paper process, and it will not announce
itself any other way.

## The two drills, on day 2

Do them on day 2, not day 7, so a failure still leaves time to fix and restart.

- **Clean restart.** Stop one run with `pkill -INT -f 'main.ts paper -- rsi-mean-reversion'`, confirm
  `runs.status = 'finished'` and `stop_reason = 'signal'`, wait one interval, then
  `npm run paper -- rsi-mean-reversion SNEK --resume <id>`. Confirm `paper_orders.seq` continues and
  `params.resumes` gained a timestamp.
- **Crash recovery.** `kill -9` the same run's real node process, confirm the row is stuck at
  `running`, confirm `/` shows its heartbeat STALE, confirm no process survives, then resume. It
  succeeds through the stale-heartbeat path and records that fact as a warning on the run. A run
  whose heartbeat is still fresh must be refused — that refusal is what stops two processes writing
  one run.

Full procedures are in `RUNBOOK-paper.md`.

## When to stop the run

Abandon and restart rather than nurse a run through any of these:

- **No candle at any boundary for more than two hours.** The paper runs are producing nothing; fix
  the collector first. `/`'s collector line and each run's `empty` counter both show it.
- **The quota verdict reads STOP.** Stop the collector, not the paper runs; the paper runs will
  simply have a gap, and a gap you understand is better than a suspended account.
- **A run stops itself** with `stop_reason` beginning `feed failing:`. It hit twelve consecutive
  failing boundaries. Resuming into the same broken feed just aborts again — fix the cause first.
- **Disk below 5 GB** (`doctor` warns). Postgres and three log files will not end well.
- **A run's report carries the multi-pool warning and you care about the result.** Its equity curve
  is not one pool's history and its fees are not one venue's fees. That is a reason to understand the
  outage, not necessarily to abandon the week — but it is not a result to quote without the caveat.
- **You changed the strategy code.** A week's equity curve has to come from one git sha. If a fix
  is unavoidable, stop the runs, note it, and start a new week.

## The laptop hazards, said plainly

`caffeinate -is` prevents idle and system sleep **while on AC power**. It does not prevent sleep when
you close the lid. For a seven-day run that means: keep it plugged in, keep the lid open, and expect
a reboot or a power cut to end every process at once. Recovery is the crash-recovery drill, three
times, and the runs continue from their last persisted candle — nothing is lost beyond the in-flight
intents of one boundary each.

If that constraint is unacceptable, the answer is not a better incantation; it is moving the run off
the laptop, which is the M5 candidate in `docs/specs/2026-09-07-m4-dashboard.md` §9.

## At the end

Write `docs/ops/<date>-m3-report.md` containing:

- each precondition with the output that proved it;
- the seven daily reports for each run, as they were taken;
- the two drills and what the run rows looked like after each;
- the acceptance queries from Plan 3 Task 7 Step 5;
- the `/compare` table for the three runs, and which venues were touched with `assumed` rather than
  documented costs;
- the sentence **this is a plumbing check, not a strategy result** beside any profit-and-loss figure;
- a verdict: *M3 met*, or *M3 not met because …* against spec §8.

Then open its PR. The run ids in the report are the whole audit trail: anyone can re-derive every
number in it with `report <id>` and `report --compare`.
