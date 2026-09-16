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

| drill | expected | observed (date, time) | notes |
|---|---|---|---|
| 0 self-test | | | |
| 0b wrong credential | | | |
| 1 silence | | | |
| 2 failing check | | | |
| 3 unit failure | | | |
| 3b backup failure | | | |
| 4 maintenance | | | |
| 4b expiry | | | |
| 5 memory | | | |
| 6 secrets | | | |

## Deployment history

_(T035: the founder's decision on timing, recorded here with the time.)_
