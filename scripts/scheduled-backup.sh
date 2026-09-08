#!/bin/bash
#
# The nightly backup, as launchd runs it.
#
# launchd does NOT read a login shell: no ~/.zshrc, no nvm, and a PATH that on this machine is
# empty. So `npm` is not on PATH and nothing here may assume it is. Everything this needs is
# resolved explicitly, and every way it can fail writes a line to the log rather than exiting
# silently — an unattended backup that quietly stops is worse than no backup, because you believe
# you have one.
#
# Run it by hand exactly as launchd will:  ./scripts/scheduled-backup.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || { echo "FATAL: cannot cd to $REPO"; exit 1; }

say() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { say "FAILED: $*"; exit 1; }

say "starting scheduled backup in $REPO"

# 1. node, the way .nvmrc asks for it. launchd gives us none, so load nvm ourselves.
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nvm use --silent >/dev/null 2>&1 || true
fi
command -v node >/dev/null 2>&1 || fail "node not found; nvm at ${NVM_DIR:-$HOME/.nvm} did not provide it"
say "node $(node -v) at $(command -v node)"

# 2. Docker, because the dump runs pg_dump inside the postgres container to keep client and server
#    on the same version. A stopped Docker Desktop is the likeliest reason for a missed backup.
if ! command -v docker >/dev/null 2>&1; then
  for d in /usr/local/bin /opt/homebrew/bin "$HOME/.docker/bin" /Applications/Docker.app/Contents/Resources/bin; do
    [ -x "$d/docker" ] && export PATH="$d:$PATH" && break
  done
fi
command -v docker >/dev/null 2>&1 || fail "docker not found on PATH; is Docker Desktop installed?"
docker ps --format '{{.Names}}' 2>/dev/null | grep -qx ctb_postgres \
  || fail "the ctb_postgres container is not running; start Docker Desktop and \`docker compose up -d\`"

# 3. The backup itself. npm lives beside node.
say "running npm run backup"
if npm run backup 2>&1; then
  say "backup OK"
else
  fail "npm run backup exited non-zero (see the lines above)"
fi

# 4. Verify the copy that would actually be used in a disaster, when R2 is configured. A backup that
#    is never restored is a belief, not a control — and this is the cheap moment to test it.
if grep -q '^R2_SECRET_ACCESS_KEY=.' .env 2>/dev/null; then
  say "verifying the remote copy"
  if npm run backup:verify:remote 2>&1; then say "remote verify OK"; else fail "remote verify failed"; fi
else
  say "R2 not configured; local backup only, nothing to verify remotely"
fi

say "done"
