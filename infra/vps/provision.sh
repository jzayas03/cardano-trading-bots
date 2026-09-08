#!/bin/bash
#
# Bare Ubuntu 24.04 -> a host ready to run the bot. Idempotent: safe to re-run.
#
#   ssh root@<ip> 'bash -s' < infra/vps/provision.sh
#
# It deliberately does NOT place .env, clone the repo, or start anything. Secrets are placed by
# hand; see the end of the output.
set -euo pipefail

SERVICE_USER=ctb
NODE_MAJOR=24

say() { printf '\n== %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

say "timezone -> UTC"
# Every log line, every timer boundary and the collector's own tick buckets are UTC. A host on
# local time makes each of those disagree with the others in a way that only shows up at 03:00.
timedatectl set-timezone UTC

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw postgresql-client jq >/dev/null

say "node ${NODE_MAJOR} from NodeSource"
# apt, not nvm. A supervisor gets none of a login shell, and nvm cost us a wrapper on macOS that has
# to source nvm.sh itself. /usr/bin/node removes that whole class of failure from every unit file.
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

say "docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
systemctl enable --now docker
docker --version

say "service user ${SERVICE_USER}"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$SERVICE_USER"
usermod -aG docker "$SERVICE_USER"
# The bot's processes must survive logout and start at boot without anyone signing in.
loginctl enable-linger "$SERVICE_USER"
# Same key that reaches root reaches the service user, so there is one credential to rotate.
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "/home/$SERVICE_USER/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  install -m 600 -o "$SERVICE_USER" -g "$SERVICE_USER" /root/.ssh/authorized_keys "/home/$SERVICE_USER/.ssh/authorized_keys"
fi

say "firewall: ssh only"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
ufw status verbose | head -5

say "ssh hardening"
# Keys only, no root shell. Written as a drop-in so an Ubuntu upgrade to sshd_config cannot quietly
# revert it, which editing the main file in place would allow.
cat > /etc/ssh/sshd_config.d/10-ctb.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t && systemctl reload ssh
echo "  password auth disabled, root login key-only"

say "unattended security updates"
apt-get install -y -qq unattended-upgrades >/dev/null
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

cat <<EOF

== provisioned. what this did NOT do, on purpose:

  1. place ${SERVICE_USER}'s .env          <- secrets are yours to put there, mode 600
  2. clone the repository
  3. start Postgres, the collector, or any paper run

next:
  ssh ${SERVICE_USER}@<ip>
  git clone <repo-url> ~/cardano-trading-bots
  # create ~/cardano-trading-bots/.env by hand (chmod 600), then:
  bash ~/cardano-trading-bots/infra/vps/deploy.sh
EOF
