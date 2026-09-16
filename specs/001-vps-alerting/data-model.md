# Data Model: VPS Alerting

**Feature**: `specs/001-vps-alerting/spec.md` | **Date**: 2026-09-16

There is no new database table. Every entity below is either state held by the external
dead-man's-switch service, a message on the wire, or a small file on the box. The one persistent
thing the box owns is the maintenance window, and it is a file so that it survives a watchdog
process and can be read by a unit's failure handler without a database connection.

## Entities

### Check (external, one per box)

The service's expectation of this box's schedule. Configured once, by hand, in the service's UI;
the box never creates or modifies it.

| field | value for this box | where it lives |
|---|---|---|
| name | the hostname (e.g. `ubuntu-2gb-ash-2`) | service |
| period | 15 min, equal to `ctb-watch.timer`'s `OnUnitActiveSec` | service |
| grace | 20 min, so period + grace = 35 min = FR-003's bound | service |
| state | `up`, `down`, `grace`, `paused`, `new` | service |
| last ping | timestamp and kind of the last report received | service |
| ping URL | the secret; carries the check's UUID | `.env` on the box as `CTB_HEALTHCHECK_URL` |

Validation: `CTB_HEALTHCHECK_URL` is optional in config (absent means alerting is off and the
watchdog behaves exactly as today); when present it must be an `https://` URL with no query string
and no trailing slash, so the box can append `/fail`, `/start`, `/log` and `/<exit-status>`.

### Report (wire, box to service)

One HTTP request from the box to the check. Never stored on the box beyond the log line that
records the attempt and its outcome.

| field | values | notes |
|---|---|---|
| kind | `alive`, `fail`, `start`, `log`, `test` | maps to the ping URL suffix: none, `/fail`, `/start`, `/log`, and `/log` with a `test` marker in the body |
| exit status | 0-255 | alternative to `kind` for unit failure handlers: `/<exit-status>` |
| body | UTF-8 text, at most 8 kB (well under the service's 100 kB cap) | the watchdog's verdict lines, or the unit name and reason; FR-012 applies |
| run id | client UUID (`rid`) | optional; not used in v1 (the watchdog does not send `/start`) |
| outcome | `accepted`, `rejected`, `unreachable` | derived from the HTTP result: 200 body `OK` is accepted; 200 body `OK (not found)` or `(rate limited)` or any 4xx is rejected; network error or timeout is unreachable |

Validation of the body, enforced before sending and unit-tested: contains none of the strings
that the config loader knows as secrets (`DATABASE_URL`, `POSTGRES_PASSWORD`,
`BLOCKFROST_PROJECT_ID`, `R2_*`, `CTB_HEALTHCHECK_URL` values), no `postgres://` URL, no
39-character Blockfrost project id pattern, and no e-mail address. A body that fails the filter is
replaced by a fixed line `[redacted: body failed the secret filter]` and the attempt is logged as
such, so a redaction bug is visible rather than silent.

### Alert (external, delivered to the founder)

The service's notification. The box never sees it. Modelled here only to state what the founder
receives for each transition; the service owns the state machine.

| trigger | alert kind | opens / closes |
|---|---|---|
| no report for period + grace | silence (`down`) | opens |
| `fail` report or `/<non-zero>` | failure (`down`) | opens, or updates an open one |
| `alive` after `down` | recovery (`up`) | closes |
| `log` report | none | attaches text to the check's log only |

Reminder cadence and quiet hours are service settings (FR-017: one reminder per hour, no quiet
hours).

### Maintenance window (box, a file)

`/home/ctb/ctb-maintenance.json`, mode 600, owned by `ctb`, written by the `maintenance` command
and read by the watchdog and by the unit failure handler.

| field | type | rule |
|---|---|---|
| `until` | ISO-8601 UTC timestamp | required; the window is active iff `now < until`; a file whose `until` is in the past is treated as absent and deleted on next read |
| `reason` | string, at most 200 chars | required; appears in the start and end notices |
| `declaredAt` | ISO-8601 UTC | set by the command |
| `maxMinutes` | constant 240 | the command refuses a longer window; FR-009 "expires on its own" is enforced by both the timestamp and this cap |

State transitions: absent → active (command `maintenance start --minutes N --reason ...`, sends a
`log` report "maintenance started ... until ..."); active → absent (command `maintenance end`, or
`until` passes; the next watchdog cycle notices the expiry, deletes the file and sends a `log`
report "maintenance ended"). While active: the watchdog still sends `alive` on a healthy-or-failed
cycle and puts the verdict in the body prefixed `[maintenance]`; unit failure handlers send `log`
instead of `/<exit-status>`.

### Unit failure event (box, transient)

Produced by systemd when a unit enters `failed` (a one-shot exits non-zero, or a `Restart=always`
service hits `StartLimitBurst`). Handled by one templated unit `ctb-alert@.service` invoked via
`OnFailure=ctb-alert@%n.service` in each watched unit.

| field | source | notes |
|---|---|---|
| unit name | `%i` of the alert template = `%n` of the failed unit | e.g. `ctb-paper@ma-crossover.service` |
| result | `systemctl show -p Result,ExecMainStatus,NRestarts <unit>` | `exit-code`, `start-limit-hit`, `signal`, ... |
| exit status | `ExecMainStatus` | sent as `/<exit-status>` when non-zero and not in maintenance |
| timestamp | the handler's own clock | included in the body as data; the service stamps receipt |

Firing frequency, measured on the box 2026-09-16 (drill 3): for a `Restart=always` unit systemd
runs `OnFailure=` on EVERY failed attempt (once per `RestartSec`; six handler runs before
`StartLimitBurst` stopped the loop), not once at the limit, and the unit's final `Result` is
`exit-code`, not `start-limit-hit`, so the handler cannot tell the last attempt from the others.
One-shot units (backup) fire once. The dead-man's-switch service pages on the transition to down
and dedupes the rest, so FR-008's "one alert per restart-limit event" holds for the PAGE; the
handler log and the service's ping log carry one line per attempt. A per-unit debounce on the box
is a possible follow-up (T039, reserved range).

## Relationships

```text
ctb-watch.timer ──every 15 min──▶ ctb-watch.service (npm run watch)
                                        │ verdict (Check[] → {line, exitCode})
                                        ▼
                                  alerting.report(kind, body)  ──HTTPS──▶  Check (service)
                                        ▲                                       │
   ctb-maintenance.json ────read────────┤                                       ▼
                                        │                                Alert → founder's phone
ctb-paper@*.service ─OnFailure─▶ ctb-alert@%n.service ─┘
ctb-collector.service ─OnFailure─┘
ctb-backup.service ─OnFailure────┘

npm run alert -- test  ──────────────▶  Check (as `log`, body "TEST from <host> at <time>")
```

## Invariants

1. `alive` is sent only after the watchdog has finished and reached a verdict; never before,
   never from a unit handler. The dead-man's switch measures the watchdog, nothing else.
2. A watchdog cycle sends exactly one report: `alive` (OK or WARN-only), or `fail`. Never both.
3. Maintenance never suppresses `alive` (FR-010). It changes `fail` → `alive` with a
   `[maintenance]` body and `/<exit-status>` → `log`.
4. A report failure never changes the watchdog's exit status or the unit's own outcome (FR-015).
5. The credential never appears in any body, log line, argv or error message. Error messages name
   the host of the URL and the status code, never the path.
