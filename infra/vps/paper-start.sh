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

# Two call shapes, because systemd and a human want different things.
#
#   paper-start.sh ma-crossover SNEK --max-gap-min 20     <- by hand, explicit
#   paper-start.sh ma-crossover_SNEK --max-gap-min 20     <- from a unit, where %i is all we get
#
# The second exists because `ctb-paper@.service` had the ticker HARDCODED as `SNEK` in its
# ExecStart, so every instance of the template traded the same token and a second instrument was
# impossible without a second template. `%i` is the only thing systemd hands a template, so the
# instance name has to carry both parts.
#
# Separator is `_`, not `:`. Strategy ids use hyphens (`ma-crossover`, `rsi-mean-reversion`,
# `buy-and-hold`, `scheduled-accumulation`) so a hyphen cannot separate them, and a colon would land
# inside `StandardOutput=append:/path`, whose own syntax is colon-separated. Underscore appears in
# neither a strategy id nor a ticker, and is safe in a filename. Split on the LAST underscore.
USAGE="usage: paper-start.sh <strategy> <TICKER> [extra args...]  |  paper-start.sh <strategy>_<TICKER> [extra args...]"
RAW="${1:?$USAGE}"
case "$RAW" in
  *_*)
    STRATEGY="${RAW%_*}"
    TICKER="${RAW##*_}"
    shift
    ;;
  *)
    STRATEGY="$RAW"
    TICKER="${2:?$USAGE}"
    shift 2
    ;;
esac

# Catch the mistake this refactor makes newly possible: an instance named `ctb-paper@ma-crossover`
# with no ticker would otherwise take `--max-gap-min` as the token and start a run against nothing.
[ -n "$STRATEGY" ] || { echo "empty strategy in '$RAW'. $USAGE" >&2; exit 1; }
if ! [[ "$TICKER" =~ ^[A-Z][A-Z0-9]*$ ]]; then
  echo "ticker '$TICKER' does not look like a ticker (expected uppercase alphanumeric). $USAGE" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

# Run tsx DIRECTLY instead of through `npm run paper`. Measured on the live box 2026-09-16: the four
# paper runs carried 267 MB of `npm` wrapper processes that do nothing once the child is up -- 28% of
# the 966 MB the runs consumed in total, on a box with 811 MB free. At eight runs that is over 500 MB
# of nothing, which is most of the gap between "eight instances fit tightly" and "eight instances
# fit". `npm run paper` resolves to exactly this command (package.json), nothing in packages/ reads
# any npm_* variable, and paper-start.sh has already cd-ed to $REPO and sourced .env.
#
# No fallback to npm on purpose. A missing tsx means a broken install, and a silent fallback would
# restore the 267 MB while looking like it worked.
RUNNER="$REPO/node_modules/.bin/tsx"
[ -x "$RUNNER" ] || { echo "missing $RUNNER -- run npm ci in $REPO" >&2; exit 1; }

# Split off the `.` so the directive actually covers it: a directive binds to the NEXT command, so
# on `set -a; . ./.env; set +a` it bound to `set -a` and the source was never exempt at all.
set -a
# shellcheck source=/dev/null  # .env is gitignored, so it can never be followed from a checkout
. ./.env
set +a

if [ "${CTB_PAPER_FORCE_NEW:-0}" = "1" ]; then
  echo "CTB_PAPER_FORCE_NEW=1: starting a new run for $STRATEGY/$TICKER without looking for one to resume"
  exec "$RUNNER" packages/cli/src/main.ts paper "$STRATEGY" "$TICKER" "$@"
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
  exec "$RUNNER" packages/cli/src/main.ts paper "$STRATEGY" "$TICKER" --resume "$RUN_ID" "$@"
fi

echo "nothing to resume for $STRATEGY/$TICKER (no running row, none signalled within ${RESUME_WINDOW_SECONDS}s); starting a new run"
exec "$RUNNER" packages/cli/src/main.ts paper "$STRATEGY" "$TICKER" "$@"
