#!/bin/bash
#
# Checkout -> running. Run as ROOT, on the host, after provision.sh:
#
#   ssh root@<ip> 'bash -s' < infra/vps/deploy.sh
#
# Root because installing system units needs it. Everything that touches the repo or the database
# runs as the ctb user via sudo -u, so nothing in ~ctb ends up root-owned — an ownership mistake
# there surfaces days later as a unit that cannot write its own log.
set -euo pipefail

SERVICE_USER=ctb
HOME_DIR="/home/$SERVICE_USER"
REPO="$HOME_DIR/cardano-trading-bots"
ENV_FILE="$REPO/.env"

say() { printf '\n== %s\n' "$*"; }
die() { echo "FAILED: $*" >&2; exit 1; }
asctb() { sudo -u "$SERVICE_USER" -H bash -lc "cd '$REPO' && $*"; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -d "$REPO/.git" ] || die "$REPO is not a git checkout; clone it as $SERVICE_USER first"

say "secrets"
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing; create it by hand (chmod 600) before deploying"
PERMS="$(stat -c '%a' "$ENV_FILE")"
[ "$PERMS" = "600" ] || die ".env is mode $PERMS; must be 600 (chmod 600 $ENV_FILE)"
[ "$(stat -c '%U' "$ENV_FILE")" = "$SERVICE_USER" ] || die ".env is not owned by $SERVICE_USER"
for v in DATABASE_URL BLOCKFROST_PROJECT_ID; do
  grep -q "^$v=." "$ENV_FILE" || die "$v is missing or empty in .env"
done
echo "  .env present, mode 600, owned by $SERVICE_USER, required keys set"

say "logs"
install -d -m 755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$HOME_DIR/logs" "$HOME_DIR/ctb-backups"

say "code"
asctb "git fetch --prune origin && git checkout main && git pull --ff-only"
asctb "git log --oneline -1"

say "dependencies"
# ci, not install: the lockfile is the contract, and a deploy that silently resolves a different
# tree than CI tested is the drift this project keeps finding.
asctb "npm ci --silent"

say "postgres"
asctb "docker compose up -d postgres"
for _ in $(seq 1 30); do
  asctb "docker compose exec -T postgres pg_isready -U ctb" >/dev/null 2>&1 && break
  sleep 2
done
asctb "docker compose exec -T postgres pg_isready -U ctb" >/dev/null 2>&1 || die "postgres did not become ready"
echo "  postgres ready"

say "migrations"
asctb "npm run migrate"

say "systemd units"
install -m 644 "$REPO/infra/vps/systemd/"*.service "$REPO/infra/vps/systemd/"*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ctb-collector.service
for s in ma-crossover rsi-mean-reversion buy-and-hold; do
  systemctl enable --now "ctb-paper@$s.service"
done
systemctl enable --now ctb-backup.timer ctb-watch.timer

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
