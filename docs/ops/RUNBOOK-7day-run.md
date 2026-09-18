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
3. **`npm run test:live` is green** on the dependencies you are about to run for a week.

   **First recorded green 2026-09-17 10:38 UTC**, on the box at `44fa230`: `Test Files 1 passed (1)`,
   `Tests 2 passed (2)`, 189.24s. Both tests RAN -- read `2 passed`, never the exit code, because the
   file is `describe.skipIf(!LIVE)` on `RUN_LIVE_TESTS` and `BLOCKFROST_PROJECT_ID`, so a missing
   credential SKIPS every test and still exits 0. `vitest` does not load `.env`, so the box needs
   `set -a; . ./.env; set +a` first or it silently proves nothing. Full log: `/var/tmp/testlive.log`.

   **Budget ~2,800 calls, not the ~1,100 this line claimed until 2026-09-17.** Only 570 of that is
   measured: the first test prints its own cost, 550 discover + 20 refresh. The second prints
   nothing and deliberately sweeps FOUR times to exercise the retry path, so its ~2,200 is INFERRED
   from the first test's sweep size. Treat ~2,800 as a ceiling to budget against, not a reading. Check the day before spending it -- a full day is ~38,000 of
   the 50,000 tier, and the ~5,700-call discovery sweep runs once, at 00:30 UTC:

   ```sql
   SELECT sum(provider_calls) FROM collector_runs WHERE started_at > current_date;
   ```

   Run it nice'd so it always loses to the collector, as with the sidecar install:
   `set -a && . ./.env && set +a && nice -n 19 ionice -c3 npm run test:live`. It cost ~230 MB for
   189 s on 2026-09-17 and left 600 MB available, so it does not threaten the paper runs.
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

**The whole sequence, and what no gate checks.** The `cutover` command gates steps 2, 4 and 7.
The other nine are unguarded, so it is written down: an unguarded step that lives only
in someone's head is the one that gets skipped at 03:00. Each numbered item links to its own section
below where it has one.

```
 0. [ ] Take a MANUAL backup, immediately before stopping           <- no gate, margin is thin
 1. [ ] Confirm the gate is on the box (command below)
 2. [ ] cutover --phase before-stop --expect-sha OLD --runs ...     <- gated
 3. [ ] DRILL 2, while the runs are stopped                         <- no gate, only chance
 4. [ ] cutover --phase after-stop                                  <- gated, load-bearing
 5. [ ] Reboot, then the off-host firewall test                     <- "Reboot the box", below
 6. [ ] Deploy: pull, npm ci, deploy.sh (does the instance RENAME)  <- rehearse it first, step 6a
 7. [ ] cutover --phase after-deploy --expect-sha NEW               <- gated
 8. [ ] Start the eight ONE AT A TIME, reading `available` between  <- "Add NIGHT", below
 9. [ ] report --compare on the box                                 <- no gate, NEVER RUN THERE
10. [ ] Enable multi-venue sampling                                 <- own section, below
11. [ ] Rotate the Postgres passwords                               <- own section, below
```

**0 — the backup margin is thinner than it looks.** `MAX_BACKUP_AGE_HOURS` is 26 and `ctb-backup.timer`
fires at 03:30 UTC, so a cutover starting near 03:00 begins at ~23.5 h and keeps ageing while you work
through the stop and drill 2. Do not discover that mid-cutover: `systemctl start ctb-backup.service`
first, confirm a new file in `~ctb/ctb-backups` and `ExecMainStatus=0`, then proceed.

**3 — drill 2 has been deferred since 2026-09-16 and this is the window it was deferred TO.** It stops
a paper unit, and a stop forks the run, so it cannot be done while a measurement week is live. Once
the new runs start it gets deferred again, for the same reason, for another week. Row 2 of the table
in `RUNBOOK-alerting.md` has the procedure and the expected page text.

**6a — the rename has never executed, and getting it wrong is an OOM found by reboot.** The box has
four instances enabled as `ctb-paper@<strategy>`; `paper-instances.txt` names eight as
`<strategy>_<TICKER>`. `deploy.sh` disables the ones the file does not name — and that loop was fed by
a command that returns nothing for template instances, so **it had never run once** (proven on the
live box 2026-09-17, four enabled, zero reported). If it fails to disable the old four, twelve paper
processes come up on a box that fits eight. Rehearse it on the laptop before you touch the box, and
read the list `deploy.sh` prints as it disables:

```bash
infra/vps/test-deploy-enabled-instances.sh   # any machine with Docker; lifts the function out of
                                             # deploy.sh at run time so it cannot drift
```

**9 — neither the promotion gate nor the exposure block has ever executed on the box.** As of
2026-09-18 the box is 44 commits behind, so the specs/003 interval gate and the whole of specs/004
(`packages/reports/src/exposure.ts` does not exist there) will run against real rows for the first
time. Run `report --compare` after the deploy and read the output rather than assuming it worked;
a gate that has never executed in its deployment environment is untested there, whatever CI says.

**Two things that are NOT cutover steps but come due with it.** `ctb_dashboard_local_only` is still
public and unrotated (`RUNBOOK-postgres-exposure.md`), and the alpha/beta measurement must be re-run
once the OLD windows close — all four runs report `window-open` while they are live, so every figure
in `docs/ops/2026-09-18-exposure-first-run.md` was taken with that refusal deliberately bypassed and
is not a result.

**NIGHT starts its evidence clock at zero.** The cutover adds a second instrument, the gate compares
within a token, and NIGHT has no history. Nothing about NIGHT can promote for at least a full window,
and `MIXED_TOKENS_WARNING` in `compare.ts` exists so that a cross-token read is not made by accident.

---

Every step is gated by the `cutover` command, which performs nothing and refuses when the state is
not what the next step needs. **Any FAIL stops the sequence.** Every fact it cannot read comes back as a
FAIL, not a pass — a check that could not run is not a verdict, and here the cost of stopping to look
is minutes while the cost of proceeding on an unknown is the week's data.

**Whether the gate is on the server is a QUESTION, not a constant — ask it every cutover.** The box
sits deliberately behind `main`, because the week's equity curve has to come from one git sha, so
whether `npm run cutover` exists there depends on which sha is deployed *this* time. Ask first:

```bash
ssh ctb@<ip> 'cd cardano-trading-bots && git log --oneline -1 && \
  (git merge-base --is-ancestor dfc1d50 HEAD && echo "GATE IS ON THE BOX" || echo "NOT ON THE BOX")'
```

- **On 2026-09-16 the answer was NO.** The VPS ran `0d42901`, 62 commits behind, and `dfc1d50` was
  not an ancestor of it. Because the deploy is step 4, the two gates that matter most (`before-stop`
  and the load-bearing `after-stop`) were both unrunnable at the moment they are invoked, and only
  `after-deploy` worked as written. The sidecar below exists for that case.
- **On 2026-09-17 the answer is YES.** The box runs `44fa230`, which contains `dfc1d50`. Verified by
  running it, not by reading git: `--phase before-stop --runs 150,151,152,153` on the live checkout
  returned OK for backup, runs alive and worktree clean, plus the designed FAIL for a missing
  `--expect-sha`. **When the answer is yes, skip the whole sidecar** and use the plain form:

```bash
ssh ctb@<ip> "cd cardano-trading-bots && npm run cutover -- \
  --phase before-stop --expect-sha OLD_SHA --runs 150,151,152,153"
```

This section said flatly "the gate is not on the server" until 2026-09-17, by which point it had
been false for a day. A fact about the deployed sha goes stale at every deploy, which is why it is
written here as a command to run rather than an answer to trust.

**If and only if the check says NOT ON THE BOX, bootstrap the gate from a throwaway checkout:**

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
  --phase before-stop --expect-sha OLD_SHA --runs 150,151,152,153
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

None of the sidecar paragraphs above apply when the check at the top of this section says the gate is
already on the box — and after a deploy that carries `dfc1d50`, it stays there. They are kept because
the condition recurs: pin the box far enough behind `main` again and the gate is once more missing at
exactly the moment it is needed.

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
costs nothing, and that day it is `--expect-sha 44fa230` with the runs still up. It should read
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

- `before-stop` wants **`OLD_SHA` — `44fa230`**, the sha the week actually ran on. `$LIVE` has not
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

1. **Stop the paper runs and the collector.** Derive the list from the box, never from this page:
   this line named THREE units until 2026-09-17 while four were running, which would have carried
   run 150 (the scheduled-accumulation baseline) straight through the cutover.
   ```bash
   ssh root@<ip> "systemctl stop \$(systemctl list-units 'ctb-paper@*' --no-legend --plain \
     | awk '{print \$1}' | tr '\\n' ' ') ctb-collector"
   ```
   Then confirm nothing survived: `systemctl list-units 'ctb-paper@*' --no-legend --plain` is empty.

2. **Prove the stop was clean.** Same bootstrap invocation, from `$LIVE`, no `--expect-sha` (this
   phase does not check the sha):
   `cd "$LIVE" && "$GATE/node_modules/.bin/tsx" --tsconfig "$GATE/tsconfig.json" "$GATE/packages/cli/src/main.ts" cutover --phase after-stop --runs 150,151,152,153`
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

### Reboot the box at this cutover, BEFORE starting any units — but do NOT resize

**FOUNDER DECISION 2026-09-17: the 4 GB box is SKIPPED.** Stay on the CPX11. The resize this section
originally prescribed was sized from summed RSS, which counts the shared node binary once per
process; on `Private_Dirty` eight runs is ~530 MB (budget table in step 3 of the start-up procedure
below), which fits the 2 GB box with roughly 600-700 MB to spare. The upgrade was ~$40/month for
headroom that measurement says is already there.

**What survives the decision is the REBOOT**, and it is not optional. Step 4 below is the only free
chance to test the firewall's reboot persistence: the block was written six hours AFTER the kernel
now running booted, so it has never once replayed from `after.rules`. A cutover is the only window
where a reboot costs nothing, and skipping the resize must not quietly take the reboot with it.

Two consequences of staying at 2 GB, both already handled elsewhere in this file and both worth
knowing before you start eight units:

- **Eight instances is the ceiling, not a step toward sixteen.** Four instruments x four strategies
  does not fit here. Two instruments is what this box supports.
- **Start them ONE AT A TIME watching `free -m`**, per step 3 of the start-up procedure. If
  `available` drops under 250 MB, stop — the margin is real but it is not unlimited.

If the decision is ever revisited, the rescale dialog offers CPU+RAM only or CPU+RAM+disk: **choose
CPU and RAM only.** A disk upgrade cannot be undone, the server can never be rescaled back down
afterwards, and disk is not the constraint — 30 G of 38 G is free.

Order:

```
# 1. Runs are already stopped (see above). Confirm nothing is writing:
ssh ctb@<ip> "systemctl is-active 'ctb-paper@*' ctb-collector; \
  docker exec -i ctb_postgres psql -U ctb -d ctb -At -c \
  \"SELECT count(*) FROM runs WHERE status='running'\" </dev/null"
#    Expect: inactive for every paper unit, and 0 running rows.

# 2. Stop the collector and Postgres cleanly, then reboot.
ssh root@<ip> "systemctl stop ctb-collector ctb-backup.timer ctb-watch.timer; \
  cd /home/ctb/cardano-trading-bots && sudo -u ctb docker compose stop postgres; reboot"

# 3. Verify the box came back as expected BEFORE deploying anything:
ssh ctb@<ip> "nproc; free -m | sed -n 2p; df -h / | tail -1; uptime -p"
#    Expect: UNCHANGED 2 vCPU and ~1,914 MB -- this is a reboot, not a rescale -- the same 38 G
#    disk, and a fresh uptime. A changed core or memory count means someone resized after all.

# 4. The firewall's reboot persistence is now finally testable, and this is the only free chance
#    to test it. From ANOTHER machine, not the box:
nc -z -w 8 <ip> 5433 ; echo "rc=$?"     # non-zero is the pass
#    Record the result in docs/ops/RUNBOOK-postgres-exposure.md. Until this line exists, that
#    control is designed-for and not demonstrated -- the block was written six hours AFTER the
#    kernel that is running now booted, so it has never actually replayed from after.rules.

# 5. Confirm Postgres and the collector came back, then continue to the NIGHT step below.
ssh ctb@<ip> "docker ps --format '{{.Names}} {{.Status}}'; systemctl is-active ctb-collector"
```

**If anything about step 3 or 4 surprises you, stop and do not start the paper units.** A cutover that
starts eight runs on a box whose firewall or database did not come back correctly is a week spent
measuring the wrong thing.

### Add NIGHT as a second instrument, at this cutover

Decided 2026-09-16, and the instrument half still holds. (The sample-size half was superseded on
2026-09-17 by specs/003: the gate now asks whether a resampled interval on the round-trip mean
excludes zero, instead of counting to thirty. That bought a better question, not more evidence —
`bootstrap.ts` measures 83-93% coverage at n = 30 and concludes the constraint is the trade count,
not the estimator — so adding an instrument is still the lever.) NIGHT costs **152.3 bps** per round trip at 500 ADA against SNEK's
**293.3** — SNEK is the twelfth-cheapest of eighteen viable tokens, so every week so far has paid
about 142 bps of avoidable handicap. Evidence: `docs/ops/2026-09-16-parallel-instruments.md`.

**Instance names changed.** `ctb-paper@.service` no longer hardcodes `SNEK`; `%i` is now
`<strategy>_<TICKER>`. So `ctb-paper@ma-crossover` becomes `ctb-paper@ma-crossover_SNEK`, and
`infra/vps/paper-instances.txt` is the single source of truth for which instances exist.

Run this **only with the old runs stopped** (the step above), and **in this order**:

```
# 1. Old instance names must not survive into the reboot. deploy.sh disables any enabled
#    ctb-paper@ instance the file does not name, and prints each one it disables -- read that list.
ssh root@<ip> 'bash -s' -- --sha <sha> --no-start < infra/vps/deploy.sh

# 2. Confirm the file's eight instances are enabled and nothing else is.
#    NOT `list-unit-files --state=enabled`: that lists TEMPLATE FILES, and an instance of a template
#    is enabled by a symlink in the wants directory, so it prints NOTHING no matter how many
#    instances are enabled. Proven on the live box 2026-09-17 with four instances enabled: it
#    returned empty. A check that answers "none" whatever the truth cannot catch the leftover
#    old-named units this step exists to catch.
ssh root@<ip> "ls -1 /etc/systemd/system/multi-user.target.wants/ | grep '^ctb-paper@' | sed 's/\.service$//'"

# 3. Start them ONE AT A TIME, checking memory between each. Each run is now ONE process, not the
#    four it was (`npm run paper` -> `sh -c` -> `tsx` bin -> node): paper-start.sh execs node with
#    the tsx hooks directly.
#
#    BUDGET ~67 MB PER RUN, and read that off `available`, not off summed RSS. RSS counts the
#    shared node binary once per process, so summing it across ten node processes inflates
#    everything -- it is how the wrapper saving was first written here as 267 MB when the real
#    figure was ~74 MB. The honest number is Private_Dirty, measured on the box 2026-09-16:
#
#        npm run paper   18.4 MB   removed (#170)
#        sh -c            0.1 MB   removed (#170)
#        tsx bin         14.5 MB   removed (this change)
#        node + app      66.5 MB   what is left
#
#    Eight runs is therefore ~530 MB against the ~1,080 MB this box was using with four runs of the
#    old shape. If `available` drops under 250 MB, STOP and do not start the rest.
#
#    To re-measure rather than trust this:
#      ssh root@<ip> 'for p in $(pgrep -f "main.ts paper"); do awk "/^Private_Dirty:/{print \$2}" /proc/$p/smaps_rollup; done'
for i in ma-crossover_SNEK rsi-mean-reversion_SNEK buy-and-hold_SNEK scheduled-accumulation_SNEK \
         ma-crossover_NIGHT rsi-mean-reversion_NIGHT buy-and-hold_NIGHT scheduled-accumulation_NIGHT; do
  ssh root@<ip> "systemctl start ctb-paper@$i && sleep 20 && free -m | sed -n 2p"
done
```

**Then verify the thing that would otherwise be silently wrong:**

```
# Each run is on the token its unit name claims. A paper run against the wrong token does not
# error -- it produces a clean, wrong equity curve, which is why paper-start.sh refuses a
# mis-named instance outright (infra/vps/test-paper-start.sh step 4).
docker exec -i ctb_postgres psql -U ctb -d ctb -At -F' | ' -c \
  "SELECT r.id, r.strategy_id, t.ticker, r.status FROM runs r JOIN tokens t ON t.unit = r.base_unit
    WHERE r.status = 'running' ORDER BY t.ticker, r.strategy_id"
```

Expect **eight running rows, four SNEK and four NIGHT**, each strategy appearing once per token. The
gate compares within a token, so a token missing a baseline makes its candidates unpromotable.

**If memory forces a stop**, drop NIGHT's `ma-crossover` first: keep both baselines plus one
candidate per token, because a candidate without both baselines cannot clear `beats-baselines`
whatever it returns.

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
