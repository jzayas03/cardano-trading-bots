#!/bin/bash
#
# OnFailure= handler: tell the dead-man's-switch service that a unit failed, right now, not at the
# next 15-minute watchdog tick. Invoked by ctb-alert@.service as
#
#   alert-unit-failure.sh <failed-unit-name>          (systemd passes %i, which is the failed unit's %n)
#
# Contract: specs/001-vps-alerting/contracts/unit-failure-handler.md. Proven by
# infra/vps/test-alert-unit-failure.sh, which stubs systemctl/curl and asserts the exact URL suffix
# and body — run it before trusting a change here.
#
# Deliberately shell, not Node: this must work when node_modules is mid-`npm ci`, when Postgres is
# the thing that failed, and when the failing unit is the collector the Node CLI shares code with.
# It needs only bash, curl, systemctl, date, hostname, mktemp. (systemd-escape was in this list
# until #137: the handler used to unescape %i, which is exactly the bug that fix removed.)
#
# ALWAYS exits 0. A handler that fails makes systemd log a second failure and alerts nobody.
set -euo pipefail
set +x   # never trace a line that holds the URL

REPO="${CTB_REPO:-/home/ctb/cardano-trading-bots}"
ENV_FILE="$REPO/.env"
MAINT_FILE="$HOME/ctb-maintenance.json"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# %i is the failed unit's literal name (OnFailure=ctb-alert@%n.service). Do NOT pass it through
# `systemd-escape --unescape`: in systemd's escaping "-" stands for "/", so unescaping a plain name
# mangles every hyphen. The first live drill (2026-09-16 16:59 UTC) paged with
# "unit: ctb/paper@no/such/strategy.service" for exactly that reason.
UNIT="${1:-}"
if [ -z "$UNIT" ]; then say "alert-unit-failure: no unit name given"; exit 0; fi

# What failed, from systemd's own record. Any of these may be empty on an odd unit type.
RESULT=""; STATUS=""; NRESTARTS=""
while IFS='=' read -r k v; do
  case "$k" in
    Result) RESULT="$v" ;;
    ExecMainStatus) STATUS="$v" ;;
    NRestarts) NRESTARTS="$v" ;;
  esac
done < <(systemctl show -p Result -p ExecMainStatus -p NRestarts "$UNIT" 2>/dev/null || true)
RESULT="${RESULT:-unknown}"; STATUS="${STATUS:-unknown}"; NRESTARTS="${NRESTARTS:-0}"

# The URL is read into a variable and never echoed, traced, or placed in argv of anything but curl.
URL=""
if [ -r "$ENV_FILE" ]; then
  URL="$(grep '^CTB_HEALTHCHECK_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
fi
if [ -z "$URL" ]; then
  say "alerting off (no CTB_HEALTHCHECK_URL); $UNIT failed: $RESULT/$STATUS restarts=$NRESTARTS"
  exit 0
fi

# Maintenance window: a file with an `until` in the future. Parsed without jq (not on the box).
MAINT_REASON=""; MAINT_UNTIL=""
if [ -r "$MAINT_FILE" ]; then
  until_raw="$(grep -o '"until"[[:space:]]*:[[:space:]]*"[^"]*"' "$MAINT_FILE" | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  reason_raw="$(grep -o '"reason"[[:space:]]*:[[:space:]]*"[^"]*"' "$MAINT_FILE" | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  if [ -n "$until_raw" ]; then
    until_epoch="$(date -u -d "$until_raw" +%s 2>/dev/null || echo 0)"
    if [ "$until_epoch" -gt "$(date -u +%s)" ]; then
      MAINT_UNTIL="$until_raw"; MAINT_REASON="${reason_raw:-unstated}"
    fi
  fi
fi

BODY="$(hostname) $(date -u +%Y-%m-%dT%H:%M:%SZ)
unit: $UNIT
result: $RESULT
exit: $STATUS
restarts: $NRESTARTS"
if [ -n "$MAINT_UNTIL" ]; then
  BODY="$BODY
maintenance: $MAINT_REASON until $MAINT_UNTIL"
fi

# Suffix: /log inside maintenance (the service records it, nobody is paged); otherwise the exit
# status as the service's own exit-status endpoint, or /fail when there is no usable number.
if [ -n "$MAINT_UNTIL" ]; then
  SUFFIX="/log"
elif [[ "$STATUS" =~ ^[0-9]+$ ]] && [ "$STATUS" -ge 1 ] && [ "$STATUS" -le 255 ]; then
  SUFFIX="/$STATUS"
else
  SUFFIX="/fail"
fi

TMP="$(mktemp)"
code="$(curl -fsS -m 10 --retry 2 --retry-delay 5 -X POST --data-binary "$BODY" "$URL$SUFFIX" -o "$TMP" -w '%{http_code}' 2>/dev/null || printf '000')"
resp="$(head -c 40 "$TMP" 2>/dev/null | tr -d '\n' || true)"
rm -f "$TMP"
say "$UNIT $RESULT/$STATUS restarts=$NRESTARTS -> $SUFFIX: http ${code:-000} ${resp}"
exit 0
