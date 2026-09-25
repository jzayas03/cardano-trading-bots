# Cutover preflight — 2026-09-23

`RUNBOOK-7day-run.md` § *The cutover, in order* is the procedure. This file is that procedure with
**this** cutover's values resolved, the preconditions it states as questions actually asked, and two
defects in its drill-2 step that would have made the drill prove nothing. Read both. Where they
disagree, this file is the newer measurement and says why.

Everything below marked *verified* was run on 2026-09-23 between 17:47Z and 18:05Z. Nothing on the
box was changed: every probe was a read.

> **Updated 2026-09-25: `NEW_SHA` moved to `c5ce700`**, the `main` tip after #199 merged, so the
> resume fix ships with the cutover (see *Why #199 goes in this deploy*). The repo-side checks below
> were re-run against the new sha. The **box-side** rows (run ids, backup age, open window, memory,
> checkout clean) are the 2026-09-23 read and were NOT re-read: if the cutover runs on a later day,
> re-read each of them first. The backup row has already expired on its own terms (2026-09-24 05:30Z);
> step 0 takes a fresh one regardless.

## Resolved values

| name | value | how it was resolved |
|---|---|---|
| `OLD_SHA` | `44fa230fd0ae5a74d45a9d02c7d3139c7ec30269` | `git rev-parse HEAD` in the live checkout |
| `NEW_SHA` | `c5ce7002c6d52925dbf03a8c7fbfa412fa1f53d9` | `origin/main` tip after #199 merged (founder decision 2026-09-23: deploy main tip; 2026-09-25: merge #199 first). Was `6c55beb` |
| `--runs` | `150,151,152,153` | the four rows `status='running'`, re-read today, not copied forward |
| distance | 49 commits | `git rev-list --count 44fa230..origin/main`, re-counted 2026-09-25 (48 + #199) |
| week | started 2026-09-16 12:34:33Z, **7 days elapsed 2026-09-23 12:34:33Z** | `runs.created_at` |

The four runs are still writing past the seven-day mark (last tick 17:45Z, heartbeats 1 min old).
That is harmless, but it means **the window is open-ended until the stop**: cut `report --compare`
at a stated boundary, or each run's window is "however long the cutover took" and the four differ.

## Preconditions, asked today

| check | result | evidence |
|---|---|---|
| gate on the box | **YES** | `git merge-base --is-ancestor dfc1d50 HEAD` → `GATE IS ON THE BOX`. The whole `$GATE` sidecar in the runbook does not apply tonight — use the plain `npm run cutover` form |
| cutover tool identical at both shas | **YES** | `git diff 44fa230 origin/main -- packages/cli/src/commands/cutover.ts packages/reports/src/cutover.ts` is empty, re-run at `c5ce700`. Steps 2, 4 and 7 run as written; `--phase`, `--expect-sha` and `--runs` all parse at `44fa230` (`cutover.ts:56-62`) |
| live checkout clean | **YES** | `git status --porcelain` empty |
| backup fresh | **YES, with 11 h of margin** | newest dump `2026-09-23T03:30:04Z`, 14.3 h old at 17:47Z; `MAX_BACKUP_AGE_HOURS=26` expires it 2026-09-24 05:30Z. Step 0 still takes a manual one |
| no maintenance window open | **YES** | `npm run maintenance -- status` → `no maintenance window`. Load-bearing for drill 2, below |
| the rename rehearsal (step 6a) | **PASS, all five steps** | `infra/vps/test-deploy-enabled-instances.sh` run locally today, exit 0. Step 5 is the real transition in script order: four old names disabled, the file's eight enabled, no survivor |
| migrations to apply | **none** | `0001`–`0009` byte-identical across the 49 commits |
| new required env keys | **none** | no `.env.example` additions across the 49 commits (#199 touches only `paper.ts` and its test) |
| memory headroom | 804 MB available with the four old runs up | `free -m` |

## Why #199 goes in this deploy

Before #199, `defaultResumeLiveness` counted live paper processes by **strategy only**. The eight new
instances (`infra/vps/paper-instances.txt`) run every strategy on both SNEK and NIGHT, so an instance
that dies without recording a stop (SIGKILL, OOM) would count its live sibling on the other token,
refuse `--resume` as "already running", and after `StartLimitBurst=5` stay `failed` until someone
steps in. At `6c55beb` the new week would have been one OOM away from that. #199 passes the ticker.

It does **not** change drill 2 (step 3). The drill runs on the OLD sha, where `44fa230` still carries
the strategy-only count, but the four old instances are one per strategy, all SNEK, so there is no
sibling to miscount and the recovery half resumes run 153 as written.

## Defect 1 — drill 2, as written, cannot fire

`RUNBOOK-alerting.md` row 2 says: `systemctl stop ctb-paper@<strategy>`; wait one cycle; restart.
That command cannot produce the failure it is meant to prove.

- `ctb-paper@.service` sets **`KillSignal=SIGINT`**, deliberately, so that `systemctl stop` runs the
  clean path.
- `paper.ts:366-367` (at `c5ce700`; `359-360` at `6c55beb`) handles it and the signal path "always records `status: 'finished'`".
- `checkPaperRuns` (`watch.ts:109`) filters to `status === 'running'` first, and with none returns
  **`ok: no run is marked running`**.

So a clean stop leaves nothing for the check to complain about: no FAIL, no push, and the drill
reads as a broken alerting pipeline rather than a passing one. The state it is trying to create —
a row marked `running` with no process — needs the handler bypassed:

```bash
# ONE command: Restart=always/RestartSec=60 means systemd brings it back in 60 s, and the
# restart RESUMES the row, erasing the state the drill exists to create. The stop cancels that.
ssh root@<ip> "systemctl kill -s SIGKILL ctb-paper@ma-crossover && systemctl stop ctb-paper@ma-crossover"
```

Use **`ma-crossover`** (run 153): it is the worst performer of the four and is being retired within
the hour either way. Because the row stays `running`, `paper-start.sh` **resumes** it rather than
forking — so unlike the clean-stop case that caused the 2026-09-16 deferral, this costs no run id.

Confirm the state before waiting for the page, or you are timing an alert against a state you never
created:

```bash
ssh ctb@<ip> "cd cardano-trading-bots && docker compose exec -T postgres psql -U ctb -d ctb -Atc \
  \"SELECT id, strategy_id, status FROM runs WHERE status='running' ORDER BY id\" </dev/null"
# Expect FOUR rows still, 153 among them, and no process behind 153:
ssh root@<ip> "pgrep -af 'main.ts paper' | sed 's/ --.*//'"
```

Expected page, within one watchdog cycle (15 min), text containing:
`FAIL: paper run 153 (ma-crossover/SNEK) — marked running but no process is running it`.

Note the run id and ticker are in the name (`watch.ts:113`); the runbook's expected text predates
that and reads `paper ma-crossover`. Record what actually arrives.

A second, *different* page may also arrive within seconds, from `OnFailure=ctb-alert@%n.service`
naming the unit. Whether it does depends on whether systemd routes a SIGKILL under `Restart=always`
through `failed` or straight to auto-restart. It is not the drill's success criterion either way —
row 2 is about the **watchdog** text. Record both arrivals and which endpoint each used.

Recovery half: `systemctl start ctb-paper@ma-crossover` resumes run 153, and the next cycle should
read `ok ... alive (pid N)`. Only then stop it cleanly with the others.

## Defect 2 — drill 2 sits inside the maintenance window, where it is suppressed

The twelve-step checklist declares maintenance at step 0 and runs drill 2 at step 3 — inside it.
Maintenance suppresses exactly this kind of page: drill 4 proved a forced failure inside a window
logs `-> /log: http 200 OK` and does **not** push, and drill 3b's first attempt was lost that way
("**never run 3b while a window is open**"). Both endpoints answer `http 200 OK`, so a suppressed
drill and a delivered one differ by four characters in `alert.log`.

Run drill 2 **before any maintenance window is opened**, which means before the collector stop and
the reboot, and confirm the push arrived on the founder's phone before opening one.

Nothing pages just because the paper units stopped: `OnFailure` fires on `failed`, not on a clean
stop, and with every row `finished` the paper check returns `ok`. The window is needed for the
*collector* stop, the reboot and the deploy — not for stopping the paper runs.

## Defect 3 — the password rotation is in two places, in two different orders

The checklist puts the rotation at step 11, last, after the eight new runs are up. The body section
("Rotate the Postgres password once the runs are stopped") and the sidecar ordering both put it
**before the deploy, with nothing connected**, and give the reason: `createPool` sets no
`idleTimeoutMillis`, so `ALTER ROLE` breaks the next query on every live connection — a paper run
that reaches `maxTickFailures` aborts, and its restart creates a new run id, restarting the week
you have just started.

Rotating at step 11 does to the *new* week what the section exists to prevent happening to the old
one. Take the body's order: rotate while everything is stopped, before the deploy, so that
`deploy.sh`'s `docker compose up -d postgres` recreates the container against the rotated password.
`ctb_dashboard_local_only` (migration `0006`) rotates in the same window.

## The sequence for tonight

Values filled in; `<ip>` per repo convention. Any FAIL stops the sequence.

```
 0. [ ] Manual backup: systemctl start ctb-backup.service; confirm a NEW file in ~ctb/ctb-backups
        and ExecMainStatus=0
 1. [ ] (asked today: gate IS on the box — skip the sidecar entirely)
 2. [ ] npm run cutover -- --phase before-stop --expect-sha 44fa230 --runs 150,151,152,153
 3. [ ] DRILL 2, window CLOSED, on ma-crossover — kill -9 + stop, confirm 4 rows still running,
        wait one cycle, confirm the push ARRIVED, then start the unit again and confirm recovery
 4. [ ] Stop the four paper units cleanly (derive the list from the box, never from a page)
 5. [ ] npm run maintenance -- start --minutes 180 --reason "M3 cutover"   <- only now
 6. [ ] npm run cutover -- --phase after-stop --runs 150,151,152,153       <- no running rows
 7. [ ] Rotate both Postgres passwords, nothing connected                  <- moved, see Defect 3
 8. [ ] Stop collector + Postgres, reboot, then from ANOTHER machine: nc -z -w 8 <ip> 5433
        (non-zero is the pass; record it in RUNBOOK-postgres-exposure.md — this is the only
        free chance to prove the firewall replays from after.rules)
 9. [ ] Deploy pinned, starting nothing:
        ssh root@<ip> 'bash -s' -- --sha c5ce7002c6d52925dbf03a8c7fbfa412fa1f53d9 --no-start \
          < infra/vps/deploy.sh
        READ the list of instances it disables — the four old names must appear
10. [ ] Multi-venue sampling into .env (EVERY_N_TICKS=4, MIN_DEPTH_ADA=50000), start collector,
        wait one tick
11. [ ] npm run cutover -- --phase after-deploy --expect-sha c5ce7002c6d52925dbf03a8c7fbfa412fa1f53d9
12. [ ] Start the eight ONE AT A TIME with CTB_PAPER_FORCE_NEW=1, scheduled-accumulation first,
        reading `available` between each; STOP if it drops under 250 MB
13. [ ] Eight running rows, four SNEK and four NIGHT, each strategy once per token
14. [ ] npm run maintenance -- end, after one clean watchdog cycle
15. [ ] report --compare ON THE BOX, at a stated cut boundary, then the M3 report + its PR
```

Steps 2, 6 and 11 are the gated ones. The other twelve are not, which is why they are written down.

## What I could not verify from here, and what is still yours

- **Nothing above was executed against the box.** Every remote write in this sequence is the
  founder's to run by hand; the auto-mode classifier refuses them.
- **Drill 2's push arrival** can only be confirmed on the founder's phone. `alert.log` shows the
  endpoint (`-> /1` delivered, `-> /log` suppressed) and both read `http 200 OK`.
- **The reboot's firewall test** needs a machine that is not the box and not behind the same NAT.
- **Open decision:** whether `report --compare` for the old week is cut at 12:34:33Z (exactly seven
  days) or at the stop. The runs have been writing past the mark since midday; the four must use
  the same boundary.
- **Open decision, unchanged:** `VENUE_COSTS.Minswap` 0 → 2,000,000 measured, and SundaeSwapV1 +
  MuesliSwap → `assumed` (2026-09-16). Not a cutover step, but it dates the cost floor every
  post-cutover number rests on.
