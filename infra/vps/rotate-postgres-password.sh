#!/bin/bash
#
# Rotate the Postgres password. Run as ROOT, on the host:
#
#   ssh root@<ip> 'bash -s' < infra/vps/rotate-postgres-password.sh
#
# The new password is generated ON THIS HOST and never printed, never leaves it, and never passes
# through an agent's context. `ctb_local_only` — the value this replaces — was committed to a PUBLIC
# repo and remains in its git history forever, which is the whole reason this exists.
#
# ============================ READ THIS BEFORE RUNNING IT ============================
#
# THIS WILL INTERRUPT EVERY RUNNING PAPER RUN, and may end them.
#
# `createPool` does not set `idleTimeoutMillis`, so pg's 10-second default applies: an idle
# connection is closed and the next query opens a fresh one. The instant ALTER ROLE lands, every
# process still holding the old credentials fails to authenticate on its next query.
#
# What SHOULD happen: the process dies, systemd (Restart=always) restarts it, paper-start.sh finds
# `status='running'` — a crash does not clean-stop the row — and resumes the SAME run id.
#
# What MAY happen instead: a run that reaches `maxTickFailures` (12) aborts and marks itself
# stopped. paper-start.sh then finds no running row and starts a NEW run. On a 7-day run that means
# starting the week again.
#
# So: run this BETWEEN runs, not during one. If you must run it during one, accept that outcome.
# The exposure this addresses is already closed at two layers (127.0.0.1 binding + DOCKER-USER
# drop), so the deadline is M6, not tonight.
# =====================================================================================
set -euo pipefail
set +x                      # belt and braces: never trace a line that holds the secret

SERVICE_USER=ctb
REPO="/home/$SERVICE_USER/cardano-trading-bots"
ENV_FILE="$REPO/.env"
say() { printf '\n== %s\n' "$*"; }
die() { echo "FAILED: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -f "$ENV_FILE" ] || die "$ENV_FILE missing"
[ "$(stat -c '%a' "$ENV_FILE")" = "600" ] || die ".env is not mode 600"
command -v openssl >/dev/null || die "openssl not found"

# `</dev/null` on every `docker exec` below is load-bearing, not tidiness (the same trap deploy.sh
# documents on its `asctb` helper).
#
# This script is fed to `bash -s` over ssh, so the script IS stdin. `docker exec -i` attaches stdin
# and therefore SWALLOWS THE REST OF THE SCRIPT: bash runs out of input and exits 0 with no output,
# no `die`, and nothing rotated. Run exactly as the header says, on 2026-09-16, this next line ate
# everything after it. Nothing here needs stdin (every psql statement arrives via -c and every
# secret via -e), so `-i` is gone, and stdin is closed so that a future `-i` cannot bring the bug
# back. infra/vps/test-rotate-postgres-password.sh proves the script reaches its last line.
docker exec ctb_postgres pg_isready -U ctb -d ctb </dev/null >/dev/null 2>&1 || die "postgres is not accepting connections"

# The two SELECT 1 checks at the end must connect over TCP to the container's OWN address, never
# over the Unix socket and never over loopback. The official postgres image's pg_hba.conf trusts
# `local` and 127.0.0.1 outright, so psql is not asked for a password there at all; only
# `host all all all scram-sha-256` enforces one. Proven 2026-09-16 on postgres:16 with this repo's
# compose settings: over the socket a WRONG password is ACCEPTED, so "old password is refused" could
# never fail, and every rotation rolled itself back. ALTER ROLE and rollback stay on the socket on
# purpose: they must keep working whatever password the database currently wants.
# Resolved here, before anything changes, so a container with no usable address stops the script
# cleanly instead of forcing a rollback later.
PG_ADDR="$(docker exec ctb_postgres hostname -i </dev/null 2>/dev/null | cut -d' ' -f1)"
# Two plain tests, no `{3}` quantifier: the shellcheck CI runs reads a `}` inside `[[ =~ ]]` as the
# end of a command group and then cannot find the closing `fi` of the checks below.
[[ "$PG_ADDR" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "container address '${PG_ADDR:-}' is not an IPv4 address; the verification would not enforce a password"
[[ "$PG_ADDR" != 127.* ]] || die "container address $PG_ADDR is loopback; the verification would not enforce a password"

say "reading the current password (never printed)"
OLD="$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$OLD" ] || die "POSTGRES_PASSWORD is not set in .env; nothing to rotate from"
grep -q "^DATABASE_URL=.*:${OLD}@" "$ENV_FILE" \
  || die "DATABASE_URL does not carry the same password as POSTGRES_PASSWORD; reconcile them by hand first"

# base64 minus the characters that would need escaping inside a URL or a sed replacement.
NEW="$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-32)"
[ "${#NEW}" -eq 32 ] || die "could not generate a 32-character password"

say "backing up .env"
BACKUP="$ENV_FILE.bak-rotate-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"
echo "  $BACKUP"

say "ALTER ROLE"
# Passed via a variable so the value never appears in a process list or in this script's output.
PGPASSWORD="$OLD" docker exec -e PGPASSWORD -e NEWPW="$NEW" ctb_postgres \
  psql -U ctb -d ctb -v ON_ERROR_STOP=1 -q -c "ALTER ROLE ctb PASSWORD :'NEWPW'" \
  </dev/null >/dev/null 2>&1 || die "ALTER ROLE failed; nothing has changed"
echo "  done"

# From here a failure leaves the database wanting NEW while .env still says OLD, so every path
# below restores the old password rather than leaving the host in that state.
rollback() {
  echo "!! rolling back" >&2
  docker exec -e NEWPW="$NEW" -e OLDPW="$OLD" ctb_postgres \
    psql -U ctb -d ctb -q -c "ALTER ROLE ctb PASSWORD :'OLDPW'" </dev/null >/dev/null 2>&1 || true
  cp -p "$BACKUP" "$ENV_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  die "rolled back to the previous password"
}

say "updating .env (POSTGRES_PASSWORD and DATABASE_URL together)"
TMP="$(mktemp)"; chmod 600 "$TMP"
OLD="$OLD" NEW="$NEW" python3 - "$ENV_FILE" "$TMP" <<'PY' || rollback
import os, sys
old, new = os.environ['OLD'], os.environ['NEW']
src, dst = sys.argv[1], sys.argv[2]
out, changed = [], {'pw': 0, 'url': 0}
for line in open(src):
    if line.startswith('POSTGRES_PASSWORD='):
        out.append(f'POSTGRES_PASSWORD={new}\n'); changed['pw'] += 1
    elif line.startswith('DATABASE_URL=') and f':{old}@' in line:
        out.append(line.replace(f':{old}@', f':{new}@')); changed['url'] += 1
    else:
        out.append(line)
# Exactly one of each, or the file is not the shape this script understands.
if changed['pw'] != 1 or changed['url'] != 1:
    sys.exit(f"expected 1 POSTGRES_PASSWORD and 1 DATABASE_URL, changed {changed}")
open(dst, 'w').writelines(out)
PY
mv "$TMP" "$ENV_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "  done"

say "verifying BOTH directions"
PGPASSWORD="$NEW" docker exec -e PGPASSWORD ctb_postgres psql -h "$PG_ADDR" -U ctb -d ctb -At -c 'SELECT 1' </dev/null >/dev/null 2>&1 \
  || rollback
echo "  new password authenticates"
if PGPASSWORD="$OLD" docker exec -e PGPASSWORD ctb_postgres psql -h "$PG_ADDR" -U ctb -d ctb -At -c 'SELECT 1' </dev/null >/dev/null 2>&1; then
PGPASSWORD="$NEW" docker exec -e PGPASSWORD ctb_postgres psql -U ctb -d ctb -At -c 'SELECT 1' </dev/null >/dev/null 2>&1 \
  || rollback
echo "  new password authenticates"
if PGPASSWORD="$OLD" docker exec -e PGPASSWORD ctb_postgres psql -U ctb -d ctb -At -c 'SELECT 1' </dev/null >/dev/null 2>&1; then
  rollback   # the old one still works: the rotation did not take, and reporting success would be a lie
fi
echo "  old password is refused"

say "restarting the collector (it holds no run state, so this is free)"
systemctl restart ctb-collector

say "state"
systemctl is-active ctb-collector || true
echo
echo "NOT restarted here, on purpose: the ctb-paper@* units."
echo "They are still holding connections that authenticate with the OLD password and will fail on"
echo "their next query. Watch what happens, and check the run IDs did not change:"
echo
echo "  docker exec -i ctb_postgres psql -U ctb -d ctb -c \\"
echo "    \"SELECT id, strategy_id, status, created_at FROM runs WHERE mode='paper' ORDER BY id DESC LIMIT 6\""
echo
echo "A NEW id means the week restarted. Same ids means they crashed and resumed, which is the"
echo "intended path. Previous .env is at $BACKUP if you need to go back."
