#!/bin/bash
#
# How a paper run starts under systemd.
#
# A paper run cannot use a naive `Restart=always`. Restarting `npm run paper <strategy>` after a
# crash starts a NEW run — a second equity curve for the same strategy, with the first left
# `running` forever and nothing writing it. What a crashed run needs is `--resume <id>` against its
# own row.
#
# So: ask the database whether this strategy already has a `running` row. Resume it if so, start a
# new run if not. The refusal that protects this is `--resume`'s liveness check (#66): if a process
# really is still writing that row, the resume is refused and this exits non-zero, which is what
# systemd should see. Failing loudly beats two writers racing paper_orders.seq.
set -euo pipefail

STRATEGY="${1:?usage: paper-start.sh <strategy> <TICKER> [extra args...]}"
TICKER="${2:?usage: paper-start.sh <strategy> <TICKER> [extra args...]}"
shift 2

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

# Matched on strategy AND token. Matching on strategy alone was a latent bug: change the unit's
# ticker and this would find the OLD token's running row and try to resume it, which runPaper
# rejects with "run N is <strategy>/<old unit>, not <strategy>/<new unit>". That refusal is correct
# but the unit would simply fail to start, and the reason lives three layers down in a log.
RUN_ID="$(psql "$DATABASE_URL" -At -c "
  SELECT r.id FROM runs r JOIN tokens t ON t.unit = r.base_unit
   WHERE r.mode = 'paper' AND r.status = 'running'
     AND r.strategy_id = '${STRATEGY//\'/\'\'}'
     AND t.ticker = '${TICKER//\'/\'\'}'
   ORDER BY r.id DESC LIMIT 1")"

if [ -n "$RUN_ID" ]; then
  echo "resuming run $RUN_ID ($STRATEGY)"
  exec npm run paper -- "$STRATEGY" "$TICKER" --resume "$RUN_ID" "$@"
fi

echo "no running row for $STRATEGY; starting a new run"
exec npm run paper -- "$STRATEGY" "$TICKER" "$@"
