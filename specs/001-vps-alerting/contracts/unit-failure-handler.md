# Contract: systemd failure hooks and the handler script

**Feature**: `specs/001-vps-alerting` | **Date**: 2026-09-16

## Unit changes (`infra/vps/systemd/`)

Each watched unit gains one line in `[Unit]`:

```ini
OnFailure=ctb-alert@%n.service
```

Watched: `ctb-paper@.service`, `ctb-collector.service`, `ctb-backup.service`. Not watched:
`ctb-watch.service` (its failure is silence, by design, US1 scenario 4) and the timers (a timer
does not fail; its service does).

New template unit `ctb-alert@.service`:

```ini
[Unit]
Description=CTB alert: %i failed
# No OnFailure here: an alert handler that alerts about itself loops.

[Service]
Type=oneshot
User=ctb
WorkingDirectory=/home/ctb/cardano-trading-bots
ExecStart=/home/ctb/cardano-trading-bots/infra/vps/alert-unit-failure.sh %i
StandardOutput=append:/home/ctb/logs/alert.log
StandardError=append:/home/ctb/logs/alert.log
TimeoutStartSec=30
```

`%i` is the failed unit's full name because the watched units use `OnFailure=ctb-alert@%n.service`
(`%n` = full unit name, escaped; the handler unescapes with `systemd-escape --unescape`).

`deploy.sh` must add `ctb-alert@.service` to the files it installs (it already globs
`*.service`), must not add it to `UNITS` (a template is never enabled or started by itself), and
`systemd-analyze verify` on all units is part of the deploy's checks so a typo in `OnFailure=` is
caught before it silently never fires.

## Handler: `infra/vps/alert-unit-failure.sh <unit>`

Runs as `ctb`, under `set -euo pipefail` and `set +x`. Must pass shellcheck on CI's older version
(no `{n}` quantifiers). Needs only `bash`, `curl`, `systemctl`, `systemd-escape`, `date`,
`hostname`. No Node, no database.

```text
1. UNIT := systemd-escape --unescape "$1"
2. read RESULT, STATUS, NRESTARTS := systemctl show -p Result -p ExecMainStatus -p NRestarts "$UNIT"
3. read URL from .env: grep '^CTB_HEALTHCHECK_URL=' .env | cut -d= -f2-   (never echoed)
   if empty: log "alerting off (no CTB_HEALTHCHECK_URL); $UNIT failed: $RESULT/$STATUS" and exit 0
4. MAINT := ~/ctb-maintenance.json if it exists and its `until` is in the future
5. BODY  := "<hostname> <ISO now>\nunit: $UNIT\nresult: $RESULT\nexit: $STATUS\nrestarts: $NRESTARTS"
            + "\nmaintenance: <reason> until <until>" when MAINT
6. suffix := MAINT ? "/log" : ( STATUS is a 1..255 integer ? "/$STATUS" : "/fail" )
7. curl -fsS -m 10 --retry 2 --retry-delay 5 -X POST --data-binary "$BODY" "$URL$suffix" -o /tmp/resp -w '%{http_code}'
8. log one line: "$UNIT $RESULT/$STATUS -> $suffix: http <code> <first 40 chars of response>"
9. exit 0 always (a handler that fails makes systemd log a second failure and nothing else)
```

Step 7's `curl` output is written to a private temp file (`mktemp`, not `/tmp` on the VPS —
`/tmp` is a 957 MB tmpfs, but a 100-byte response is fine there; the point is the file is
unlinked immediately). `--retry` covers a transient network blip; the total wall time stays under
the unit's `TimeoutStartSec=30`.

The body contains the unit name, result, exit code, restart count, timestamp and the maintenance
reason. Nothing else. The `.env` read is the only place the URL exists in the process and it is
never printed; `set +x` is explicit so a future `bash -x` cannot trace it.

## Harness: `infra/vps/test-alert-unit-failure.sh`

Same shape as `test-rotate-postgres-password.sh`: runs the handler under `bash -s`-equivalent
conditions inside a throwaway container with `systemctl`, `systemd-escape`, `hostname` and `curl`
stubbed on `PATH`. The `curl` stub records the URL suffix and the body and returns `200 OK`.
Asserts:

1. `ctb-paper@ma-crossover.service` with `Result=start-limit-hit ExecMainStatus=1` → suffix `/1`,
   body names the unit, result and exit.
2. same with an active maintenance file → suffix `/log`, body carries the reason.
3. `Result=exit-code ExecMainStatus=0`? (cannot happen for a failed unit, but) → suffix `/fail`.
4. no `CTB_HEALTHCHECK_URL` in the fake `.env` → no `curl` call recorded, exit 0, log line present.
5. the recorded body does not contain the URL or any `.env` value.
6. the script exits 0 when the `curl` stub returns a network error.

The stub `curl` must reproduce the property under test: it reads `--data-binary` from argv and
records it, so a body that accidentally included the URL would be caught by assertion 5.
