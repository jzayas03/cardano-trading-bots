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

All as `ctb` from `/home/ctb/cardano-trading-bots` unless the row says root. Rows marked † need
only the unit files, the handler and `CTB_HEALTHCHECK_URL` in `.env`; the rest need the watchdog
change deployed with a sha.

| drill | command | expected | observed (date, time) | notes |
|---|---|---|---|---|
| 0 self-test † | `npm run alert -- test` | exit 0 within 1 min; output `accepted (http 200 OK) host=<host>`; a `TEST from <host> at <ISO>` entry in the check's ping log | | must not print the URL |
| 0b wrong credential † | `env CTB_HEALTHCHECK_URL=https://<same host>/ping/00000000-0000-0000-0000-000000000000 npm run alert -- test` | exit 1 within 1 min; output `rejected (http 200 "OK (not found)") host=<host>` | | `.env` untouched: `grep -c '^CTB_HEALTHCHECK_URL=' .env` still 1, value unchanged |
| 1 silence | as root: `systemctl stop ctb-watch.timer`; wait; `systemctl start ctb-watch.timer` | "down" push at 35 min ± the service's scheduler tick; "up" within one cycle (15 min) of the start | | stop nothing else |
| 2 failing check | **only in a stopped window** (see the warning above): `systemctl stop ctb-paper@<strategy>`; wait one cycle; restart | push within 15 min whose text contains `FAIL: paper <strategy> — marked running but no process is running it`; recovery ("up") the next cycle after the restart | | otherwise `npm run alert -- send --kind fail --body 'drill 2 deferred'` and record "deferred to the next stopped window" with the date |
| 3 unit failure † | as root: `systemctl start ctb-paper@no-such-strategy`; afterwards `systemctl reset-failed ctb-paper@no-such-strategy` | five restarts in ≤ 5 min, then the unit is `failed` (`Result=exit-code`, `NRestarts=5`; systemd does NOT report `start-limit-hit` on the unit itself); the handler runs on EVERY failed attempt, so `journalctl -u 'ctb-alert@*' --since -10min` shows six runs and `alert.log` six lines, each `-> /1: http 200 OK`; the service pages ONCE, on the first, and dedupes the rest; `SELECT count(*) FROM runs WHERE status='running'` unchanged | 2026-09-16: started 16:59:14Z; handler fired 16:59:15Z (first attempt) and at 17:00:17, 17:01:18, 17:02:19, 17:03:20, 17:04:20Z; unit `failed` 17:04:23Z; run rows 4 before and after; push arrival: _founder to record_ | a bad strategy never reaches `createRun` (`paper.ts` throws at line 348, `createRun` is line 490), so no run row. Defect found by this drill: the body read `ctb/paper@no/such/strategy.service` — the handler unescaped `%i`; fixed in #137, handler re-installed on the box 2026-09-16 17:12Z from merged sha `1d1defc` (checksum verified) and re-checked under a 2-minute maintenance window so the check could not page: `ctb-paper@ma-crossover.service success/0 restarts=0 -> /log: http 200 OK` — hyphens intact. The window file was removed straight after |
| 3b backup failure † | as root: `systemd-run --unit=ctb-backup-drill -p User=ctb -p WorkingDirectory=/home/ctb/cardano-trading-bots -p OnFailure=ctb-alert@ctb-backup-drill.service env R2_BUCKET=does-not-exist scripts/scheduled-backup.sh` | push naming `ctb-backup-drill.service` within 2 min | | a transient unit with the same hook; the real `.env` is untouched. Record the exact command if the box's systemd wants different property syntax |
| 4 maintenance † | `npm run maintenance -- start --minutes 45 --reason drill`; repeat drill 3; `npm run maintenance -- end`; repeat drill 3 | during the window: no push, a `/log` entry in the ping log with `drill` in the body; after `end`: a "maintenance ended (manual): drill" log entry, then a push | | liveness is never suppressed: `alive` entries keep arriving every 15 min throughout (only after the watchdog change is deployed; note it if not yet) |
| 4b expiry | `npm run maintenance -- start --minutes 1 --reason expiry`; wait one watchdog cycle | `watch.log` shows "maintenance ended (expired)"; `ls ~/ctb-maintenance.json` → no such file; the ping log shows the `/log` entry | | leave no window open |
| 5 memory | `free -m` before the deploy and 30 min after, same four paper runs + collector | "available" within 20 MB of the before figure | | record all the numbers, not the difference |
| 6 secrets † | `grep -rl "$(grep '^CTB_HEALTHCHECK_URL=' .env \| cut -d= -f2- \| cut -c1-40)" /home/ctb/logs /home/ctb/cardano-trading-bots --exclude-dir=node_modules --exclude=.env` | no hits; the ping-log bodies show only unit names, run ids, ages, counts and timestamps | | record "no hits" with the date; never paste the value |

**Deployment order.** The unit files, `ctb-alert@.service` and the handler can go first: no Node,
no `npm ci`, no checkout of the live tree, `daemon-reload` only. That protects the live week
within a day and enables the † rows. The watchdog ping (`watch`, `alert`, `maintenance`) lands
with the next sha, which enables rows 1, 2, 4b and 5. Between the two, the check in the service
should be paused or given a long grace, or it will page for silence it was never promised.
Before the watchdog change is deployed there is no `alert test`; prove the URL from the box with the
service's log endpoint instead (records, never pages), as `ctb`, printing only the response:
`set +x; U=$(grep '^CTB_HEALTHCHECK_URL=' ~/cardano-trading-bots/.env | cut -d= -f2-); curl -fsS -m 10 -X POST --data-binary "setup test from $(hostname)" "$U/log"; echo` → `OK`.

**SC-009 read-back.** Once rows 1 and 3 have observed times: a stopped paper run now pages within
one watchdog period, and a unit that dies pages within two minutes; the 2026-09-16 eleven-hour gap
could not recur unnoticed.

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
- **Pending:** the watchdog change (this PR) with the next sha deploy (T038); the check's grace is
  20 min already, so between T036 and T038 the service will report the box as down for silence —
  expected, and the founder pauses the check in the service's UI until T038 if that page is unwanted.

