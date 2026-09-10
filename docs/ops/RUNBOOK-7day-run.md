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

  **The `seq` half only means something once that run has orders.** Run the drill on a strategy that
  has already traded, or accept that the assertion is vacuous and re-check it later — a strategy in
  warmup has no orders, so `max(seq)` is null before and after and proves nothing. On 2026-09-08 both
  drills ran against rsi-mean-reversion during its 16-candle warmup and that check tested nothing
  twice. `run_equity` points are the fallback: they accumulate from the first boundary, so continuity
  across a restart is visible even with no fills.
- **Crash recovery.** `kill -9` the same run's real node process, confirm the row is stuck at
  `running`, confirm `/` shows its heartbeat STALE, confirm no process survives, then resume. It
  succeeds through the stale-heartbeat path and carries that fact as a warning that lands in
  `runs.summary` when the segment ends. A run whose heartbeat is still fresh must be refused — that
  refusal is what stops two processes writing one run.

  Budget the wait: the heartbeat only reads STALE past `2 * intervalSec + graceSec`, which is 31
  minutes at a 900-second interval. Time it from the run's **last boundary**, not from the kill —
  a run killed 18 minutes after its last beat goes stale 13 minutes later, not 31.

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

### The cutover, in order

Every step is gated by `npm run cutover`, which performs nothing and refuses when the state is not
what the next step needs. **Any FAIL stops the sequence.** Every fact it cannot read comes back as a
FAIL, not a pass — a check that could not run is not a verdict, and here the cost of stopping to look
is minutes while the cost of proceeding on an unknown is the week's data.

`SHA` below is the commit being deployed. Pass it explicitly: without `--expect-sha` the check
refuses, because comparing the checkout with itself would read OK while proving nothing.

```bash
npm run cutover -- --phase before-stop --expect-sha SHA --runs 146,147,148
```

Then, and only if that is all OK:

1. **Stop the paper runs and the collector.**
   `systemctl stop ctb-paper@ma-crossover ctb-paper@rsi-mean-reversion ctb-paper@buy-and-hold ctb-collector`

2. **Prove the stop was clean.**
   `npm run cutover -- --phase after-stop --runs 146,147,148`
   The load-bearing check is **no running rows**. `paper-start.sh` RESUMES a row marked `running`, so
   one row left in that state turns the next start into a silent continuation of the old run — and
   the ids look right either way, which is what makes it dangerous rather than merely wrong.

3. **Rotate the Postgres password** — `infra/vps/rotate-postgres-password.sh`. Here, and not earlier:
   nothing is connected, so a half-applied rotation cannot break a live writer.

4. **Deploy.** Fetch, check out `SHA`, `npm ci`, `npm run migrate`.

5. **Turn multi-venue sampling on** (#98) in `~ctb/cardano-trading-bots/.env`:
   `COLLECT_MULTI_VENUE_EVERY_N_TICKS=4` and `COLLECT_MULTI_VENUE_MIN_DEPTH_ADA=50000`.

6. **Start the collector**, wait one tick interval, then:
   `npm run cutover -- --phase after-deploy --expect-sha SHA`
   This checks the collector has **ticked**, not merely that the unit is `active` — this project has
   a documented history of green deploy jobs that deployed nothing.

7. **Start `scheduled-accumulation` first.** It is a prerequisite, not a nicety: the promotion gate
   requires both baselines over an identical window, so with no baseline run nothing can clear the
   gate at all. Then the other strategies.

Only then, the report below.


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

### Enable multi-venue sampling once the runs are stopped

Founder decision 2026-09-09: merged (#97) but **kept off until the run finishes**.

```
# in ~ctb/cardano-trading-bots/.env, then: systemctl restart ctb-collector
COLLECT_MULTI_VENUE_EVERY_N_TICKS=4
COLLECT_MULTI_VENUE_MIN_DEPTH_ADA=50000
```

It prices the non-deepest venues hourly so cross-DEX spread can be measured — the one strategy
category with a plausible edge that this project has never tested properly. It costs **+4.3% of the
Blockfrost tier** (~2,140 calls/day, taking a normal day from ~78% to ~82%), which is why it waits:
spending quota during the run for a question that can wait is a bad trade, and the run is the only
measurement of whether any strategy clears its cost floor.

It is safe to enable at any time — secondary snapshots carry `is_primary=false` and can never reach
a candle (migration 0009) — so this is a budget decision, not a safety one.

**What it will and will not answer.** It measures whether spreads EXIST above the round-trip floor.
It does **not** measure whether they SURVIVE batcher latency, which is the question that decides
whether one is capturable: hourly sampling cannot see a spread that opens and closes in one to five
minutes. If spreads do clear the floor, that is the evidence to justify the much more expensive
sub-minute sampling survival analysis needs. Not before.

### Rotate the Postgres password once the runs are stopped

Founder decision 2026-09-09: do this **when the run ends**, not during it.

```
ssh root@<ip> 'bash -s' < infra/vps/rotate-postgres-password.sh
```

`ctb_local_only` was committed to this repo while it was public and remains in the git history
forever. The port is no longer exposed (#86 binds it to `127.0.0.1` and the `DOCKER-USER` block
drops the rest), so this is not urgent — but **M6 puts live order state in this database**, and M6
is gated on this very run, so the end of the run is the last quiet moment before it matters.

It waits until now because it interrupts every process holding a connection: `createPool` does not
set `idleTimeoutMillis`, so pg's 10-second default closes idle connections and `ALTER ROLE` breaks
the next query. Mid-run, a paper run that reaches `maxTickFailures` aborts, marks itself stopped,
and the next start creates a **new** run — restarting the week. With the runs already stopped there
is nothing to lose.

Order: stop the paper units and write the report FIRST, so the run rows are final, then rotate, then
confirm the collector came back. Full detail and the rollback behaviour are in
`docs/ops/RUNBOOK-postgres-exposure.md` step 3.

Rotate `ctb_dashboard_local_only` (migration `0006`) at the same time — same exposure, lower
priority only because that role is SELECT-only.
