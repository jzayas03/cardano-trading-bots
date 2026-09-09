#!/bin/bash
#
# Make the DOCKER-USER drop rules survive a reboot.
#
#   ssh root@<ip> 'bash -s' < infra/vps/harden-docker-ports.sh
#
# WHY THIS EXISTS, and why `ufw` alone is not the answer:
#
# `ufw status` on this host reported "OpenSSH only" while Postgres answered the public internet.
# Both statements were true. Docker writes its own rules into the DOCKER chain, which netfilter
# traverses BEFORE ufw's chain, so a published container port bypasses ufw entirely. Verified
# 2026-09-09 by connecting from a laptop over the internet to 5433 and reading 2,375 rows.
#
# DOCKER-USER is the one chain Docker guarantees it will not overwrite, and it is traversed before
# the DOCKER chain. `after.rules` is where ufw replays rules on reload and at boot, so putting the
# block there is what makes it durable — a plain `iptables -I` is lost on the next reboot, and
# unattended-upgrades means reboots happen unattended.
#
# This is DEFENCE IN DEPTH. The actual fix is `127.0.0.1:5433:5432` in docker-compose.yml, which
# stops the port being published off-host at all. Keep both: the compose binding is what protects
# you, and this is what protects you when someone adds a service and forgets.
set -euo pipefail

AFTER=/etc/ufw/after.rules
MARK_BEGIN='# BEGIN ctb docker-port hardening'
MARK_END='# END ctb docker-port hardening'

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -f "$AFTER" ] || { echo "$AFTER not found; is ufw installed?" >&2; exit 1; }

IF="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)"
[ -n "$IF" ] || { echo "could not determine the public interface" >&2; exit 1; }
echo "public interface: $IF"

if grep -q "$MARK_BEGIN" "$AFTER"; then
  echo "already installed; removing the old block so this stays idempotent"
  sed -i "/$MARK_BEGIN/,/$MARK_END/d" "$AFTER"
fi
cp -p "$AFTER" "$AFTER.bak-$(date -u +%Y%m%dT%H%M%SZ)"

cat >> "$AFTER" <<EOF
$MARK_BEGIN
# Drop traffic arriving on the public interface that is destined for a published container port.
# Scoped to -i $IF, so host-originated traffic (docker exec, 127.0.0.1:5433) and container-to-
# container traffic on the docker bridge are untouched.
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -i $IF -p tcp --dport 5432 -j DROP
-A DOCKER-USER -i $IF -p tcp --dport 5433 -j DROP
-A DOCKER-USER -j RETURN
COMMIT
$MARK_END
EOF

echo "--- reloading ufw"
ufw reload
echo "--- DOCKER-USER now:"
iptables -S DOCKER-USER

echo
echo "VERIFY FROM ANOTHER MACHINE, not from here -- a check run on the host cannot see this:"
echo "  nc -z -w 8 <ip> 5433 ; echo \"rc=\$?\"     # non-zero is what you want"
echo "and confirm the host still has access:"
echo "  docker exec -i ctb_postgres psql -U ctb -d ctb -At -c 'SELECT 1'"
