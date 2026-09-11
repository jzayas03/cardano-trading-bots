#!/bin/bash
#
# How a paper run starts under systemd.
#
# A paper run cannot use a naive `Restart=always`. Restarting `npm run paper <strategy>` after a
# crash starts a NEW run — a second equity curve for the same strategy, with the first left
# `running` forever and nothing writing it. What a crashed run needs is `--resume <id>` against its
# own row.
#
# So: ask the database whether this strategy has a run to take over. Resume it if so, start a new run
# if not. The refusal that protects this is `--resume`'s liveness check (#66): if a process really is
# still writing that row, the resume is refused and this exits non-zero, which is what systemd should
# see. Failing loudly beats two writers racing paper_orders.seq.
#
# "A run to take over" is NOT only a `running` row -- see infra/vps/resume-target.sql for the race
# that taught us so, live, on 2026-09-11. Set CTB_PAPER_FORCE_NEW=1 to start a fresh run regardless.
set -euo pipefail

# Generous against the ~5s restart observed, tiny against any deliberate stop-and-start-later.
RESUME_WINDOW_SECONDS="${CTB_PAPER_RESUME_WINDOW_SECONDS:-120}"

STRATEGY="${1:?usage: paper-start.sh <strategy> <TICKER> [extra args...]}"
TICKER="${2:?usage: paper-start.sh <strategy> <TICKER> [extra args...]}"
shift 2

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

if [ "${CTB_PAPER_FORCE_NEW:-0}" = "1" ]; then
  echo "CTB_PAPER_FORCE_NEW=1: starting a new run for $STRATEGY/$TICKER without looking for one to resume"
  exec npm run paper -- "$STRATEGY" "$TICKER" "$@"
fi

# Matched on strategy AND token. Matching on strategy alone was a latent bug: change the unit's
# ticker and this would find the OLD token's row and try to resume it, which runPaper rejects with
# "run N is <strategy>/<old unit>, not <strategy>/<new unit>". That refusal is correct but the unit
# would simply fail to start, and the reason lives three layers down in a log.
#
# `-v` binding rather than string interpolation: psql quotes `:'x'` itself, so the ticker and
# strategy cannot break out of the literal.
ROW="$(psql "$DATABASE_URL" -At \
  -v strategy="$STRATEGY" -v ticker="$TICKER" -v window_seconds="$RESUME_WINDOW_SECONDS" \
  -f "$REPO/infra/vps/resume-target.sql")"

if [ -n "$ROW" ]; then
  IFS='|' read -r RUN_ID RUN_STATUS STOP_REASON STOPPED_AGO <<EOF
$ROW
EOF
  if [ "$RUN_STATUS" = "running" ]; then
    echo "resuming run $RUN_ID ($STRATEGY): row still marked running"
  else
    echo "resuming run $RUN_ID ($STRATEGY): ${RUN_STATUS}/${STOP_REASON} ${STOPPED_AGO}s ago, inside the ${RESUME_WINDOW_SECONDS}s restart window"
  fi
  exec npm run paper -- "$STRATEGY" "$TICKER" --resume "$RUN_ID" "$@"
fi

echo "nothing to resume for $STRATEGY/$TICKER (no running row, none signalled within ${RESUME_WINDOW_SECONDS}s); starting a new run"
exec npm run paper -- "$STRATEGY" "$TICKER" "$@"
