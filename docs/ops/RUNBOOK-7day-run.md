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

> **Before running either drill, check `Restart=` on `ctb-paper@.service`.** It is `Restart=always`,
> and `ExecStart` is `paper-start.sh` — so systemd relaunches the unit within `RestartSec` of the
> process exiting, and the manual `--resume` below never gets the chance to run. Whether that
> relaunch resumes or FORKS depends on the deployed code: before #113, `paper-start.sh` matched only
> `status='running'`, so a clean SIGINT — which writes `finished`/`stop_reason='signal'` — forked
> every time. The drill would then be manufacturing the exact defect of 2026-09-11 on a live week.
>
> `systemctl stop` the unit first (that suppresses the restart), drill, then bring it back. And on a
> deployment older than #113, do not run the clean-restart drill on a run you cannot afford to split.


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

Every step is gated by the `cutover` command, which performs nothing and refuses when the state is
not what the next step needs. **Any FAIL stops the sequence.** Every fact it cannot read comes back as a
FAIL, not a pass — a check that could not run is not a verdict, and here the cost of stopping to look
is minutes while the cost of proceeding on an unknown is the week's data.

**The gate is not on the server.** `npm run cutover` arrived in `dfc1d50`; the VPS runs `0d42901`,
62 commits behind and deliberately so, because the week's equity curve has to come from one git sha.
`dfc1d50` is not an ancestor of `0d42901`, so on the live checkout the command does not exist — and
because the deploy is step 4, the two gates that matter most (`before-stop`, and the load-bearing
`after-stop`) would both be unrunnable at the moment they are invoked. Only `after-deploy` works as
written. So bootstrap the gate from a throwaway checkout first:

```bash
# On the VPS, AS ctb -- not as root. The backup check reads $HOME/ctb-backups; root's $HOME has
# none, and that fails closed as a mysterious `backup` FAIL on the one morning you cannot afford one.
LIVE=~ctb/cardano-trading-bots
# NOT /tmp. On this box /tmp is a 957M tmpfs -- it is RAM, and the clone plus ~120M of node_modules
# would come out of the ~840M the three paper runs, the collector and Postgres are sharing on 2GB.
# /var/tmp is on / with 30G free. Checked on the live box 2026-09-16.
GATE=/var/tmp/ctb-cutover
git clone https://github.com/jzayas03/cardano-trading-bots.git "$GATE"
git -C "$GATE" checkout NEW_SHA
# nice/ionice so the install always loses to the collector: a paper run that hits maxTickFailures
# aborts, and its restart creates a NEW run id, which restarts the week.
( cd "$GATE" && nice -n 19 ionice -c3 npm ci )   # its own node_modules; never touches the live tree
```

**Run it from `$LIVE`, never from `$GATE`.** The directory you stand in is the thing being measured.
`cutover` shells out to `git` without passing a `cwd`, and `main.ts` begins with
`import 'dotenv/config'`, so `deployedSha`, `gitDirtyFiles`, `DATABASE_URL` and the tick interval all
come from the current directory while the code comes from wherever the script lives. Run it from
`$GATE` and one of two things happens, neither of them a gate. Usually it simply dies: a fresh clone
has `.env.example` and not `.env`, and `DATABASE_URL` is required. But if `DATABASE_URL` happens to
be exported in your shell it runs anyway — and then `worktree clean` and `deployed sha` are
answering about the throwaway, which is clean by construction and already at the new sha. Two fake
passes, on precisely the two checks whose whole job is to describe the server.

```bash
cd "$LIVE" && "$GATE/node_modules/.bin/tsx" --tsconfig "$GATE/tsconfig.json" \
  "$GATE/packages/cli/src/main.ts" cutover \
  --phase before-stop --expect-sha OLD_SHA --runs 147,148,149
```

**`--tsconfig` is not optional, and leaving it off does not fail safe.** `tsconfig.json` maps
`@ctb/*` to `packages/*/src/index.ts` against `baseUrl: "."`, and tsx finds the tsconfig by walking
up from the CURRENT DIRECTORY. Standing in `$LIVE` therefore points that mapping at `$LIVE`, so the
sidecar's new CLI loads the LIVE checkout's OLD libraries -- the one thing this whole arrangement
exists to avoid. On 2026-09-16 that surfaced as
`SyntaxError: The requested module '@ctb/reports' does not provide an export named
'effectiveTickIntervalSec'`, because the deployed sha predates that export. Pointing `--tsconfig` at
the sidecar's own file fixes it: `baseUrl` resolves relative to the tsconfig, so the mapping lands
back inside `$GATE` while cwd keeps supplying git, `.env` and `$HOME` from the live box.

From step 4 the live checkout has the tool, so step 6 is the plain `npm run cutover`. Delete `$GATE`
when the cutover is done, so that nobody later runs a stale gate against a server that has moved on.

The alternatives, written down so they are not re-had under time pressure. Running the gate **from
the laptop** measures the laptop: `git` reads the local checkout, `$HOME/ctb-backups` is the local
backup directory, and only `runs alive` reaches the server — three of four checks would be answering
about the wrong machine. **Deploying the tooling first** means checking out the new sha and running
`npm ci` in the live tree while the runs are alive, which swaps `node_modules` under three running
processes and ends the one-sha invariant the whole week rests on. A **standalone psql/bash** version
of the checks is a second copy of a load-bearing gate that no test covers and that drifts from the
TypeScript one — and an ad-hoc psql script breaking on first use is not a hypothesis here:
`/root/post-reset.sh` did exactly that, over a boolean comparison, and skipped the restart silently.

**Do the bootstrap and one dry run the day BEFORE**, not on cutover morning. The gate is read-only —
a few SELECTs and a pool that closes in a `finally` — so a `before-stop` dry run against the live box
costs nothing, and that day it is `--expect-sha 0d42901` with the runs still up. It should read
all-OK; if it does not, you have found the problem with a day of slack rather than with the runs
already stopped. (The 62 commits add no *required* configuration — `COLLECT_MULTI_VENUE_EVERY_N_TICKS`
and `COLLECT_MULTI_VENUE_MIN_DEPTH_ADA` are both optional with defaults — so the new sha's
`loadConfig` is satisfied by the `.env` already on the server.)

This recipe was run end to end against the live box on **2026-09-16** and read four OK at exit 0,
with the sidecar at `a42927a`. It is the rehearsal that found both the `/tmp` and the `--tsconfig`
problems above — neither was visible from a laptop, because a stand-in `$LIVE` with no `tsconfig.json`
and no `packages/` cannot reproduce either one. `npm ci` took 4 s, moved available memory by 8 MB,
and the collector and three paper runs were at twelve processes before and after.

**The run ids are 147, 148 and 149, not 146, 147, 148.** Run 146 (rsi-mean-reversion) finished at
the 2026-09-11 06:16 restart and its successor is 149; the history is intact across the two rows
(217 + 70 equity points) but the identity is not. `beforeStopChecks` compares the running set for
EXACT equality, deliberately — so the old list does not warn, it FAILS, and on cutover morning a
stale doc reads as an alarming unexplained failure. Re-read the ids before the day rather than
trusting this line: `SELECT id, strategy_id FROM runs WHERE mode='paper' AND status='running';`

**The gate's query is wider than that one.** Both `beforeStopChecks` and `afterStopChecks` are fed
`SELECT id FROM runs WHERE status = 'running'` — no `mode` filter and no `rehearsal` filter. The id
query above has both, so it can show you three ids while the gate sees four. Only paper runs are
ever written `running` (a backtest row is created `finished`), so the stray in practice is a
**rehearsal** row from the day-2 drills, or a paper run somebody started by hand on another token.
Either one fails `runs alive` on exact equality at before-stop, and `no running rows` at after-stop.
The fix is to find that row and stop it, never to pad `--runs` until the gate goes quiet. What the
gate actually sees is `SELECT id, mode, rehearsal, strategy_id FROM runs WHERE status='running'
ORDER BY id;`

**Two different shas, and they are not interchangeable.** `shaCheck` compares `--expect-sha` against
the HEAD of the checkout the gate is *run from* — cwd, per above, not where the code lives — so the
right value depends on when you are asking:

- `before-stop` wants **`OLD_SHA` — `0d42901`**, the sha the week actually ran on. `$LIVE` has not
  been deployed yet at that point, and the question the check is asking is "is the server still
  where I left it?". Passing the deploy target here fails the gate at the worst possible moment for
  no reason at all.
- `after-deploy` wants **`NEW_SHA`**, the commit being deployed. There the same check is asking the
  opposite question: "did the deploy actually land?".

Pass it explicitly in both cases: without `--expect-sha` the check refuses rather than comparing the
checkout with itself, which would read OK while proving nothing.

Then, and only if before-stop is all OK:

0. **Declare maintenance** — as `ctb` from `$LIVE`, before the before-stop gate runs:
   `npm run maintenance -- start --minutes 180 --reason "M<N> cutover"`. Every stopped unit
   below would otherwise page within two minutes (`OnFailure=` → `ctb-alert@`), and the watchdog
   cycles during the stop would page with their `paper runs` FAILs. Maintenance suppresses failure
   pages, never the dead-man's switch: if the box goes silent mid-cutover you will still be paged.
   See `docs/ops/RUNBOOK-alerting.md`. (A sha older than the alerting feature has no
   `maintenance` command; the `$GATE` checkout does.)

1. **Stop the paper runs and the collector.**
   `systemctl stop ctb-paper@ma-crossover ctb-paper@rsi-mean-reversion ctb-paper@buy-and-hold ctb-collector`

2. **Prove the stop was clean.** Same bootstrap invocation, from `$LIVE`, no `--expect-sha` (this
   phase does not check the sha):
   `cd "$LIVE" && "$GATE/node_modules/.bin/tsx" --tsconfig "$GATE/tsconfig.json" "$GATE/packages/cli/src/main.ts" cutover --phase after-stop --runs 147,148,149`
   The load-bearing check is **no running rows**. `paper-start.sh` RESUMES a row marked `running`, so
   one row left in that state turns the next start into a silent continuation of the old run — and
   the ids look right either way, which is what makes it dangerous rather than merely wrong.

3. **Rotate the Postgres password** — `infra/vps/rotate-postgres-password.sh`. Here, and not earlier:
   nothing is connected, so a half-applied rotation cannot break a live writer.

4. **Deploy, pinned, and starting nothing.**
   `ssh root@<ip> 'bash -s' -- --sha NEW_SHA --no-start < infra/vps/deploy.sh`

   Both flags are load-bearing. `--sha` lands exactly that commit on a detached HEAD instead of
   whatever `main` happens to be at that second, which is what makes step 6's `--expect-sha` a check
   rather than a formality — resolve `NEW_SHA` in your own checkout **before** deploying and keep
   it, because reading it back off the server afterwards is the self-comparison the gate exists to
   forbid. `--no-start` prevents the default `systemctl enable --now`, which would start the three
   paper units the moment the deploy finished: before the env change in step 5, before the gate in
   step 6, in the wrong order for step 7, and without `CTB_PAPER_FORCE_NEW=1`. The units are still
   enabled for boot.

   It does the `npm ci` and `npm run migrate` for you. It also runs `docker compose up -d postgres`,
   which after step 3 recreates the container so its `POSTGRES_PASSWORD` matches the rotated one —
   safe here because `pgdata` is a named volume and nothing is connected yet.

5. **Turn multi-venue sampling on** (#98) in `~ctb/cardano-trading-bots/.env`:
   `COLLECT_MULTI_VENUE_EVERY_N_TICKS=4` and `COLLECT_MULTI_VENUE_MIN_DEPTH_ADA=50000`.

6. **Start the collector**, wait one tick interval, then — from `$LIVE`, which now has the tool:
   `npm run cutover -- --phase after-deploy --expect-sha NEW_SHA`
   This checks the collector has **ticked**, not merely that the unit is `active` — this project has
   a documented history of green deploy jobs that deployed nothing.

7. **Start `scheduled-accumulation` first.** It is a prerequisite, not a nicety: the promotion gate
   requires both baselines over an identical window, so with no baseline run nothing can clear the
   gate at all. Then the other strategies.

   Start them with **`CTB_PAPER_FORCE_NEW=1`**. These are new experiments, not continuations, and
   being explicit beats relying on the restart window having elapsed. `paper-start.sh` now takes
   over a run that was SIGNALLED within 120 seconds as well as one still marked `running` — see
   `infra/vps/resume-target.sql` for the race that made that necessary. A cutover spans a password
   rotation and a deploy, so it is far outside that window, but the flag says so rather than
   depending on it.

8. **End maintenance** once the new runs are up and one watchdog cycle has passed clean:
   `npm run maintenance -- end`. The window would expire on its own at 180 minutes, but ending it
   is what puts "maintenance ended (manual)" in the check's log next to the start, and a FAIL
   after this point pages again. `npm run maintenance -- status` confirms.

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
