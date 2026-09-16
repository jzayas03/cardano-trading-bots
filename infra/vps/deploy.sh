#!/bin/bash
#
# Checkout -> running. Run as ROOT, on the host, after provision.sh:
#
#   ssh root@<ip> 'bash -s' < infra/vps/deploy.sh
#   ssh root@<ip> 'bash -s' -- --no-start < infra/vps/deploy.sh
#   ssh root@<ip> 'bash -s' -- --sha <commit> --no-start < infra/vps/deploy.sh
#
# --sha pins the deploy to one commit instead of landing whatever `main` is at that second. The
# end-of-run cutover needs this: `cutover --phase after-deploy --expect-sha X` is only a check if
# the deploy was TOLD which sha to land. Without it the only way to fill in --expect-sha is to read
# HEAD back off the server after deploying, which compares the checkout with itself and proves
# nothing -- the exact non-check that --expect-sha is mandatory in order to prevent.
#
# --no-start installs and enables the units for boot but does NOT start them now. Use it whenever
# another machine is still the live one: the collector and this one share a single Blockfrost key
# with a single 50,000/day quota, and two of them refreshing at 900 s costs ~57,000 — over the cap.
# They would also back up to the same R2 prefix and prune each other's dumps.
#
# Root because installing system units needs it. Everything that touches the repo or the database
# runs as the ctb user via sudo -u, so nothing in ~ctb ends up root-owned — an ownership mistake
# there surfaces days later as a unit that cannot write its own log.
set -euo pipefail

NO_START=0
SHA=""

SERVICE_USER=ctb
HOME_DIR="/home/$SERVICE_USER"
REPO="$HOME_DIR/cardano-trading-bots"
ENV_FILE="$REPO/.env"

say() { printf '\n== %s\n' "$*"; }
die() { echo "FAILED: $*" >&2; exit 1; }
# `</dev/null` is load-bearing, not tidiness.
#
# This script is fed to `bash -s` over ssh, so the script IS stdin. `docker compose exec -T` attaches
# stdin and therefore SWALLOWS THE REST OF THE SCRIPT — bash then runs out of input and exits 0. No
# crash, no message, no `die`. On 2026-09-08 that silently ended two deploys immediately after
# "Container ctb_postgres Running", and only the missing migrations revealed it.
#
# Proven: the same script with and without this redirect prints 1 line vs 3.
asctb() { sudo -u "$SERVICE_USER" -H bash -lc "cd '$REPO' && $*" </dev/null; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-start) NO_START=1 ;;
    --sha) shift; SHA="${1:-}"; [ -n "$SHA" ] || die "--sha needs a commit" ;;
    --sha=*) SHA="${1#--sha=}"; [ -n "$SHA" ] || die "--sha needs a commit" ;;
    # Unknown flags die rather than being ignored: a typo'd --no-start that silently started the
    # paper units mid-cutover would be discovered by its consequences, which is too late.
    *) die "unknown argument: $1 (accepts --sha <commit>, --no-start)" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -d "$REPO/.git" ] || die "$REPO is not a git checkout; clone it as $SERVICE_USER first"

say "secrets"
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing; create it by hand (chmod 600) before deploying"
PERMS="$(stat -c '%a' "$ENV_FILE")"
[ "$PERMS" = "600" ] || die ".env is mode $PERMS; must be 600 (chmod 600 $ENV_FILE)"
[ "$(stat -c '%U' "$ENV_FILE")" = "$SERVICE_USER" ] || die ".env is not owned by $SERVICE_USER"
# POSTGRES_PASSWORD joined this list when the password came OUT of docker-compose.yml. Compose
# would refuse to start without it anyway (`${VAR:?}`), but failing here names the file to edit
# instead of surfacing three steps later as a compose interpolation error.
for v in DATABASE_URL BLOCKFROST_PROJECT_ID POSTGRES_PASSWORD; do
  grep -q "^$v=." "$ENV_FILE" || die "$v is missing or empty in .env"
done
echo "  .env present, mode 600, owned by $SERVICE_USER, required keys set"

say "logs"
install -d -m 755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$HOME_DIR/logs" "$HOME_DIR/ctb-backups"

say "code"
if [ -n "$SHA" ]; then
  # Detached on purpose: this is "install exactly this commit", not "follow a branch". A later bare
  # deploy re-attaches via the `git checkout main` below, so the detached state is not a trap.
  #
  # `fetch --prune origin` brings refs/heads/*, so a sha that is not on a branch is not fetched and
  # the checkout dies here rather than half-deploying. That is the right failure: pin to a commit
  # that is actually on main.
  asctb "git fetch --prune origin && git checkout --detach '$SHA'"
  echo "  pinned at $SHA (detached HEAD)"
else
  asctb "git fetch --prune origin && git checkout main && git pull --ff-only"
fi
asctb "git log --oneline -1"

say "dependencies"
# ci, not install: the lockfile is the contract, and a deploy that silently resolves a different
# tree than CI tested is the drift this project keeps finding.
asctb "npm ci --silent"

say "postgres"
asctb "docker compose up -d postgres"
# `if` rather than `cmd && break`: clearer, and it keeps the probe a condition regardless of how a
# future shell treats `set -e` here. (It was NOT the cause of the silent deploys — that was stdin;
# see asctb above. A minimal repro showed `A && break` surviving `set -e` in this bash.)
#
# 90 s, not 60: the first `docker compose up` on a new host runs initdb, which took longer than the
# original budget allowed.
ready=0
for _ in $(seq 1 45); do
  if asctb "docker compose exec -T postgres pg_isready -U ctb" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" = "1" ] || die "postgres did not become ready in 90s; check: docker logs ctb_postgres"
echo "  postgres ready"

say "migrations"
asctb "npm run migrate"

say "systemd units"
install -m 644 "$REPO/infra/vps/systemd/"*.service "$REPO/infra/vps/systemd/"*.timer /etc/systemd/system/
# The OnFailure= handler lives outside the checkout (see ctb-alert@.service) so that no hand-placed
# file ever dirties the live tree; the repo stays its source and every deploy refreshes it.
install -D -m 755 -o root -g root "$REPO/infra/vps/alert-unit-failure.sh" /usr/local/lib/ctb/alert-unit-failure.sh
systemctl daemon-reload
# An OnFailure= (or StartLimit*) line in the wrong section, or with a typo, is silently ignored by
# systemd and the alert it was meant to send never fires. verify catches that here, not on the
# night it mattered. ctb-alert@.service is a template instantiated by OnFailure=; it is never
# enabled or started by itself, so it is deliberately absent from UNITS below.
systemd-analyze verify /etc/systemd/system/ctb-*.service /etc/systemd/system/ctb-*.timer \
  || die "systemd unit verification failed; a bad OnFailure= would never fire"
UNITS=(ctb-collector.service ctb-paper@ma-crossover.service ctb-paper@rsi-mean-reversion.service ctb-paper@buy-and-hold.service)
TIMERS=(ctb-backup.timer ctb-watch.timer)
if [ "$NO_START" = "1" ]; then
  # enable (so a reboot brings them up) without starting now. The reboot test still means
  # something: it proves the units come up on their own, which is the whole point of M5.4.
  systemctl enable "${UNITS[@]}" "${TIMERS[@]}"
  echo "  enabled for boot, NOT started (--no-start)"
else
  systemctl enable --now "${UNITS[@]}" "${TIMERS[@]}"
fi

say "state"
systemctl --no-pager --plain is-active ctb-collector.service ctb-paper@ma-crossover.service \
  ctb-paper@rsi-mean-reversion.service ctb-paper@buy-and-hold.service || true
systemctl --no-pager --plain list-timers 'ctb-*' | head -4

cat <<EOF

== deployed.

  logs      : $HOME_DIR/logs/
  units     : systemctl status 'ctb-*'
  health    : sudo -u $SERVICE_USER bash -lc 'cd $REPO && npm run watch --verbose'
  dashboard : ssh -N -L 3210:127.0.0.1:3210 $SERVICE_USER@<ip>   then open http://127.0.0.1:3210/

NOT done here, on purpose: the reboot test (M5.4) and the data cutover (M5.5).
EOF
