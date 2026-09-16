# Runbook: alerting

Spec and design: `specs/001-vps-alerting/` (spec, plan, data model, `contracts/cli.md`,
`contracts/unit-failure-handler.md`, quickstart). This page is the operator's side of it.

## What it is

A dead-man's switch that lives off the box. Every watchdog cycle (`ctb-watch.timer`, every 15
minutes) ends by POSTing its verdict to a check in a hosted, healthchecks-compatible service:
`alive` when no check FAILs, `fail` when one does. The service pages the founder's phone when it
hears `fail`, and — the part no on-box mechanism can do — when it hears nothing for 35 minutes.
Separately, every long-running unit (`ctb-paper@*`, `ctb-collector`, `ctb-backup`) carries an
`OnFailure=` hook that posts to the same check within two minutes of entering `failed`, through a
shell handler that needs neither Node nor the database. The 2026-09-16 M3 week had a cutover
approved at 00:45 UTC that did not execute until 11:24, and stopped runs that nothing would have
reported; this is what would have reported them.

## Setup in the service

One-time, by hand, in the service's UI. Record the check's name, period and grace here; never the URL.

1. Create one check named for the box's hostname. Period **15 min** (equal to
   `ctb-watch.timer`'s `OnUnitActiveSec`), grace **20 min**, so period + grace = 35 min.
2. Integrations: the phone push. Reminders **hourly**, **no quiet hours** (FR-017).
3. Copy the check's ping URL into `/home/ctb/cardano-trading-bots/.env` on the box as
   `CTB_HEALTHCHECK_URL=https://…/<uuid>` — **no trailing slash, no query string**. It goes there
   and nowhere else: not in a unit file, not in a script, not in this runbook, not in chat.
   `deploy.sh` already enforces `chmod 600` on `.env`.
4. `npm run alert -- test` as `ctb` from the checkout; expect `accepted (http 200 OK) host=…`
   and a labelled entry in the check's ping log.

| check | period | grace | integration | reminders | quiet hours |
|---|---|---|---|---|---|
| _(hostname; fill in)_ | 15 min | 20 min | phone push | hourly | none |

## What each report means

| report | sent by | URL suffix | service's reaction |
|---|---|---|---|
| `alive` | `watch`, every cycle with no FAIL (warnings included) | none | resets the 35-minute clock; closes an open alert ("up") |
| `fail` | `watch`, a cycle with at least one FAIL, outside a maintenance window | `/fail` | opens an alert ("down") whose text is the body: the `STATUS: name — detail` lines and the `watch:` verdict |
| `log` | `alert test`, `maintenance start/end`, unit handler during maintenance | `/log` | attaches the body to the check's log; no alert, no clock reset |
| `/<exit-status>` | the unit failure handler (`ctb-alert@<unit>`) | `/<n>` (or `/1` for `start-limit-hit`) | non-zero opens an alert naming the unit, its result and exit status |

Rules that hold regardless of state:

- A maintenance window changes `fail` into `alive` (with `[maintenance: <reason> until <ISO>]` as
  the body's first line) and `/<exit-status>` into `log`. It never suppresses `alive`: if the box
  goes silent during maintenance you are still paged.
- The report's outcome never changes `watch`'s exit code or a unit's own result (FR-015). Delivery
  is logged in `watch.log` as one line with kind, outcome, HTTP status and host — never the URL,
  never the body.
- Without `CTB_HEALTHCHECK_URL`, `watch` is exactly what it was; `alert` exits 2; `maintenance`
  still writes and deletes its file but sends nothing.

## Rotating the URL

1. In the service, regenerate the check's ping URL (or create a new check and delete the old one).
2. On the box, as `ctb`, edit `.env` and replace the `CTB_HEALTHCHECK_URL=` line. Nothing else
   reads it; no restart is needed — `watch` runs fresh every cycle and the unit handler reads
   `.env` on each failure.
3. `npm run alert -- test`. Exit 0 and `accepted (http 200 OK)` proves the new value; a stale
   value answers `rejected (http 200 "OK (not found)")` and exit 1 — the service treats an unknown
   UUID as a 200, which is exactly why only the body `OK` counts as accepted.
4. If the old value ever appeared anywhere it should not have, treat it as leaked and rotate again.

## Drills

Every row is done when the observed time is written in. Bounds are the spec's success criteria.

**Drill 2 — only in a window where the paper runs are already stopped.** A unit stopped for one
cycle and restarted after 120 s forks its run (`infra/vps/paper-start.sh`,
`infra/vps/resume-target.sql`): the restart creates a NEW run id, and the measurement week
restarts with it. Otherwise prove the pipe with `npm run alert -- send --kind fail --body drill`
and record "deferred to the next stopped window" with the date.

All as `ctb` from `/home/ctb/cardano-trading-bots` unless the row says root. Rows marked † need only
the unit files, the handler and `CTB_HEALTHCHECK_URL` in `.env` — they are systemd and shell, so they
work from the moment the hand-deploy lands. Every other row runs a `npm run` command from the live
checkout and so needed the sha deploy (T038) — **done 2026-09-16 18:34 UTC at `44fa230`**, so every row
below is now runnable. Before it, `alert` and `maintenance` did not exist on the live checkout and
nothing sent an `alive` ping, which is what the † marks were distinguishing.

| drill | command | expected | observed (date, time) | notes |
|---|---|---|---|---|
| 0 self-test | `npm run alert -- test` | exit 0 within 1 min; output `accepted (http 200 OK) host=<host>`; a `TEST from <host> at <ISO>` entry in the check's ping log | **2026-09-16 18:35Z — `accepted (http 200 OK) host=hc-ping.com`, exit 0.** URL not printed | must not print the URL |
| 0b wrong credential | `env CTB_HEALTHCHECK_URL=https://<same host>/<a well-formed but UNKNOWN uuid> npm run alert -- test` | exit 1 within 1 min with a `rejected` outcome. **Two distinct rejections exist and only one exercises the real trap**: a well-formed unknown uuid answers `200 "OK (not found)"`, which is the case `classify` exists for because the status alone looks like success; an all-zeros uuid is refused earlier as `400 "invalid url format"`. Prefer the former. | **2026-09-16 19:19Z — exit 1, `rejected (http 200 "OK (not found)") host=hc-ping.com`.** Re-run with a freshly generated random uuid after the 18:35Z attempt used an all-zeros one and got the 400 path instead. This is the case the check exists for: a 200 that means no. `.env` identical before and after (1 line, 77 bytes both times). | never print the real URL |
| 1 silence | as root: `systemctl stop ctb-watch.timer`; wait; `systemctl start ctb-watch.timer` | "down" push at 35 min ± the service's scheduler tick; "up" within one cycle (15 min) of the start | **2026-09-16.** Last `alive` 18:42:48Z; timer stopped 18:44:01Z; box silent for 34 min (exactly one ping in `watch.log` throughout, mtime frozen at 18:42:48); down push confirmed by the founder at ~19:17:48Z, which is 18:42:48 + 15 min period + 20 min grace; timer restarted 19:18:10Z; recovery `alive` **accepted 19:18:11Z**, http 200, `watch` exit 0. All five units stayed active. | stop nothing else. Recovery beat the one-cycle bar by 15 min because `OnUnitActiveSec=15min` makes the timer fire immediately on start |
| 2 failing check | **only in a stopped window** (see the warning above): `systemctl stop ctb-paper@<strategy>`; wait one cycle; restart | push within 15 min whose text contains `FAIL: paper <strategy> — marked running but no process is running it`; recovery ("up") the next cycle after the restart | **DEFERRED 2026-09-16 to the next stopped window.** Runs 150-153 were live all day; the drill stops a paper unit, and a stop forks the run (a clean `systemctl stop` marks it `finished`/`signal` and the next start creates a new id — observed 2026-09-09, ids 146/147/148). Deferring is the documented outcome, not a gap. | the `--kind fail` deferral page was **deliberately not sent**, founder decision 2026-09-16: the deferral is a documentation fact and three genuine alerts had already landed that hour. Run this at the next cutover, before the new runs start |
| 3 unit failure † | as root: `systemctl start ctb-paper@no-such-strategy`; afterwards `systemctl reset-failed ctb-paper@no-such-strategy` | five restarts in ≤ 5 min, then the unit is `failed` (`Result=exit-code`, `NRestarts=5`; systemd does NOT report `start-limit-hit` on the unit itself); the handler runs on EVERY failed attempt, so `journalctl -u 'ctb-alert@*' --since -10min` shows six runs and `alert.log` six lines, each `-> /1: http 200 OK`; the service pages ONCE, on the first, and dedupes the rest; `SELECT count(*) FROM runs WHERE status='running'` unchanged | 2026-09-16: started 16:59:14Z; handler fired 16:59:15Z (first attempt) and at 17:00:17, 17:01:18, 17:02:19, 17:03:20, 17:04:20Z; unit `failed` 17:04:23Z; run rows 4 before and after; push arrival: _founder to record_ | a bad strategy never reaches `createRun` (`paper.ts` throws at line 348, `createRun` is line 490), so no run row. Defect found by this drill: the body read `ctb/paper@no/such/strategy.service` — the handler unescaped `%i`; fixed in #137, handler re-installed on the box 2026-09-16 17:12Z from merged sha `1d1defc` (checksum verified) and re-checked under a 2-minute maintenance window so the check could not page: `ctb-paper@ma-crossover.service success/0 restarts=0 -> /log: http 200 OK` — hyphens intact. The window file was removed straight after |
| 3b backup failure † | as root, with an ABSOLUTE path to the script: `systemctl reset-failed ctb-backup-drill; systemd-run --unit=ctb-backup-drill -p User=ctb -p WorkingDirectory=/home/ctb/cardano-trading-bots -p OnFailure=ctb-alert@ctb-backup-drill.service env R2_BUCKET=does-not-exist /home/ctb/cardano-trading-bots/scripts/scheduled-backup.sh` | push naming `ctb-backup-drill` **without the `.service` suffix** within 2 min, via the exit-status endpoint (`/1`), not `/log` | **2026-09-16 19:22:09Z — `ctb-backup-drill exit-code/1 restarts=0 -> /1: http 200 OK`, paged.** Unit started 19:22:06Z, `pg_dump` completed at an exported snapshot, `R2 PUT ... failed: 404 Not Found`, script failed 19:22:09Z, handler fired the same second. | a transient unit with the same hook; the real `.env` is untouched. **Two corrections from the first attempt.** (1) The expected text used to say `ctb-backup-drill.service`; it is `ctb-backup-drill`, because this drill passes the instance directly (`ctb-alert@ctb-backup-drill.service`, so `%i` is the bare name) while the paper units use `OnFailure=ctb-alert@%n.service`, where `%n` already carries `.service`. The handler resolves either. (2) `reset-failed` first, or `systemd-run` refuses the name. A 19:20:47Z attempt landed inside a maintenance window opened for drill 4b and went to `/log` — **never run 3b while a window is open** |
| 4 maintenance | `npm run maintenance -- start --minutes 45 --reason drill`; repeat drill 3; `npm run maintenance -- end`; repeat drill 3 | during the window: no push, a `/log` entry in the ping log with `drill` in the body; after `end`: a "maintenance ended (manual): drill" log entry, then a push | **2026-09-16 18:36Z — window opened (20 min, reason "drill 4"); a forced unit failure inside it logged `-> /log: http 200 OK`, NOT paged. Unit name read `ctb-paper@no-such-strategy.service`, hyphens intact, confirming the #137 fix on the live box** | liveness is never suppressed: `alive` entries keep arriving every 15 min throughout (only after the watchdog change is deployed; note it if not yet) |
| 4b expiry | `npm run maintenance -- start --minutes 1 --reason expiry`; wait one watchdog cycle | `watch.log` shows "maintenance ended (expired)"; `ls ~/ctb-maintenance.json` → no such file; the ping log shows the `/log` entry | **2026-09-16.** Window opened 19:19:57Z for 1 min (`until` 19:20:57.344Z). The next tick at 19:33:10Z logged `maintenance ended (expired)` (`kind=log`, accepted, http 200) at 19:33:21Z and removed the file. `watch` exit 0, all five units active. **Liveness was never suppressed:** `alive` pings accepted at 18:42:48Z, 19:18:11Z and 19:33:21Z, one per cycle straight through the window. | leave no window open. The file outlived its `until` by 12 min because removal is the watchdog's job, not the window's — that is by design, and an expired file suppresses nothing in the meantime (see the properties section below) |
| 5 memory | `free -m` before the deploy and 30 min after, same four paper runs + collector | "available" within 20 MB of the before figure | **2026-09-16 — 825 MB available before alerting, 863 MB after, same four paper runs and collector. No regression; it improved by 38 MB** | record all the numbers, not the difference |
| 6 secrets † | `grep -rl "$(grep '^CTB_HEALTHCHECK_URL=' .env \| cut -d= -f2- \| cut -c1-40)" /home/ctb/logs /home/ctb/cardano-trading-bots --exclude-dir=node_modules --exclude=.env` | no hits; the ping-log bodies show only unit names, run ids, ages, counts and timestamps | 2026-09-16 17:25Z: no hits | record "no hits" with the date; never paste the value |

**Deployment order.** The unit files, `ctb-alert@.service` and the handler can go first: no Node,
no `npm ci`, no checkout of the live tree, `daemon-reload` only. That protects the live week
within a day and enables the † rows. The watchdog ping (`watch`, `alert`, `maintenance`) lands
with the next sha, which enables rows 1, 2, 4b and 5. Between the two, the check in the service
should be paused or given a long grace, or it will page for silence it was never promised.
Before the watchdog change is deployed there is no `alert test`; prove the URL from the box with the
service's log endpoint instead (records, never pages), as `ctb`, printing only the response:
`set +x; U=$(grep '^CTB_HEALTHCHECK_URL=' ~/cardano-trading-bots/.env | cut -d= -f2-); curl -fsS -m 10 -X POST --data-binary "setup test from $(hostname)" "$U/log"; echo` → `OK`.

**SC-009 read-back — MET 2026-09-16.** Rows 1 and 3 both have observed times. A unit that dies pages
within two minutes (drill 3: handler fired 1 s after the failure; drill 3b: 3 s), and a box that goes
quiet pages at 35 min (drill 1: last ping 18:42:48Z, push ~19:17:48Z) and recovers on the next tick
(19:18:11Z). The eleven-hour gap of 2026-09-16 could not recur unnoticed. What is still NOT covered is
row 2, a run that is marked running with no process behind it — deferred to the next stopped window,
so treat that specific failure as unproven rather than covered.

## Properties the drills proved that their own rows do not state

Both found by accident on 2026-09-16 while running 3b and 4b out of order. Worth keeping, because
each is a thing a future change could break silently.

- **An expired maintenance window cannot suppress a page, even before anything sweeps it.** The
  handler parses `until` and compares it to the clock; the file merely existing is not a window.
  Observed: `~/ctb-maintenance.json` was still on disk at 19:22:22Z carrying `until=19:20:57.344Z`,
  and the 3b failure at 19:22:09Z paged through it (`-> /1`) while the same drill at 19:20:47Z, ten
  seconds inside the live window, was logged instead (`-> /log`). Two independent mechanisms with
  different jobs: the handler enforces expiry by timestamp on every failure, the watchdog removes the
  file on its next tick. Already pinned: `infra/vps/test-alert-unit-failure.sh` step 2b ("EXPIRED
  maintenance file is ignored") asserts exactly this against a window five minutes in the past. The
  live drill is independent confirmation that the harness models production correctly here — which is
  the thing a harness is usually *assumed* to do and rarely checked for.
- **Running a drill inside another drill's window silently invalidates it.** 3b's first run produced a
  perfectly healthy-looking `http 200 OK` line that proved the wrong thing. The log line for a
  suppressed alert differs from a paged one by four characters — `/log` versus `/1`. When reading
  `alert.log`, read the endpoint, not the status code.

## Deployment history

- **2026-09-16 ~16:50 UTC, T035 (founder):** option (c) — unit files and handler by hand now, with a
  `daemon-reload` only, while runs 150-153 finish their measurement week; the watchdog ping ships with
  the next sha. Handler installed OUTSIDE the live checkout (`/usr/local/lib/ctb/`) so a hand-placed
  file can never dirty the tree the cutover gate checks.
- **2026-09-16 ~16:55 UTC, T037 (founder):** check created in the service (period 15 min, grace 20 min,
  push integration); `CTB_HEALTHCHECK_URL` added to `.env` by hand on the box (56 chars, `hc-ping.com`,
  UUID path, mode 600); `/log` proof from the box answered `OK`.
- **2026-09-16 16:58 UTC, T036:** hand-deploy from merged sha `fb02717` (#135 + #136): checksums matched
  local vs box; four unit files installed to `/etc/systemd/system/`; handler to
  `/usr/local/lib/ctb/alert-unit-failure.sh` (root:root 755); `daemon-reload`; `systemd-analyze verify`
  no errors; `systemctl show -p OnFailure` reads `ctb-alert@<unit>.service` on paper, collector, backup;
  `ActiveEnterTimestamp` identical before/after for the collector and all four paper units; live tree
  `git status --porcelain` empty at `722391f`.
- **2026-09-16 16:59 UTC, drill 3:** see the table. Defect: unit name mangled by `systemd-escape
  --unescape`; fix in #137; the handler on the box is re-installed from #137's merged sha (one
  `install -D`, no unit change, no reload). **Done 2026-09-16 17:12Z**, verified as above.
- **2026-09-16 18:34 UTC, T038 — the sha deploy, and the dead-man's switch went live.** Deployed
  `44fa230` with `deploy.sh --sha 44fa230 --no-start`, mid-measurement-week by founder decision.
  Risk managed rather than assumed: `docker compose up -d --dry-run postgres` was run first and
  reported `Container ctb_postgres Running`, so the compose step would not recreate the container
  and could not drop the paper runs' connections. Outcome: migrations `schema already current`;
  units installed and enabled, none started; **`ActiveEnterTimestamp` identical before and after for
  the collector and all four paper units**, and runs 150-153 unchanged. Live tree clean at `44fa230`.
  After-deploy gate: 5 OK. First `alive` ping accepted at 18:36 UTC, clearing the check that drill 3
  had left down.
- **Known and accepted:** runs 150-153 record `git_sha = 722391f` while the checkout is now
  `44fa230`. Their processes keep running the old code from memory, so no equity point is affected,
  and **no fee VALUE changed between those shas** — the cost-table work of 2026-09-16 changed only
  provenance strings and the `basis` grade. But if a paper unit restarts, it resumes its run under
  the new code while keeping the old recorded sha. That is the M3 report §7 defect, entered
  knowingly this time rather than discovered afterwards.
