#!/bin/bash
#
# Proves infra/vps/rotate-postgres-password.sh runs to its LAST line when invoked the way its header
# and the runbook say to:
#
#   ssh root@<ip> 'bash -s' < infra/vps/rotate-postgres-password.sh
#
# Under `bash -s` the script IS stdin. On 2026-09-16, run exactly like that on the VPS, it exited 0
# with no output and rotated nothing: the `docker exec -i` in the pg_isready precondition attached
# stdin and swallowed the rest of the script, and bash simply ran out of input. This harness feeds
# the script to `bash -s` inside a throwaway Linux container, so uid 0, /home/ctb, GNU stat and
# chown are real, with only `docker` and `systemctl` replaced by stubs. The docker stub drains stdin
# when given `-i`, exactly like the real one, and plays a postgres that remembers which password the
# last ALTER ROLE set.
#
# The stub's fake postgres has the official image's pg_hba.conf shape: a SELECT 1 over the Unix
# socket or loopback is TRUSTED (any password, or none, gets in), and only a connection to the
# container's own address enforces the password. That is what made the real script roll itself back
# on 2026-09-16 (the old password was "still accepted" over the socket), so a script that verifies
# without `-h <container address>` fails this harness the same way it failed on the VPS.
# The stub ENFORCES passwords on SELECT 1, which is what the script's two-way verification assumes.
# Whether the real container does the same over its Unix socket is a separate question this harness
# does not answer.
#
# Run on any machine with Docker:  infra/vps/test-rotate-postgres-password.sh
# Exit 0 = the script reached its final line and rotated the fake .env. Anything else = it did not.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" != "--inner" ]; then
  command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
  exec docker run --rm -v "$HERE:/vps:ro" python:3-slim bash /vps/test-rotate-postgres-password.sh --inner
fi

# ---- inside the container from here --------------------------------------------------------------
fail() { echo "FAIL: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "inner must run as root"
command -v openssl >/dev/null || fail "image lacks openssl"

useradd -m ctb
REPO=/home/ctb/cardano-trading-bots
ENV_FILE="$REPO/.env"
mkdir -p "$REPO"
# Placeholder values: this .env exists to be rewritten. Nothing here is a real credential.
printf 'FOO=bar\nPOSTGRES_PASSWORD=before_rotation\nDATABASE_URL=postgres://ctb:before_rotation@127.0.0.1:5433/ctb\n' > "$ENV_FILE"
chown -R ctb:ctb "$REPO"; chmod 600 "$ENV_FILE"

STUB=/stub; mkdir -p "$STUB"
echo before_rotation > "$STUB/db-password"   # what the fake postgres currently accepts
: > "$STUB/calls"

PG_ADDR=172.18.0.5                           # the fake container's eth0; loopback is anything else
cat > "$STUB/docker" <<EOF
#!/bin/bash
# Fake \`docker exec [-i] [-e K[=V]]... ctb_postgres CMD...\`. Anything else is a harness bug.
PG_ADDR=$PG_ADDR
EOF
cat >> "$STUB/docker" <<'EOF'
cat > "$STUB/docker" <<'EOF'
#!/bin/bash
# Fake `docker exec [-i] [-e K[=V]]... ctb_postgres CMD...`. Anything else is a harness bug.
set -euo pipefail
[ "${1:-}" = exec ] || { echo "stub: only 'docker exec' is modelled, got: ${1:-}" >&2; exit 64; }
shift
interactive=0
while [ $# -gt 0 ]; do
  case "$1" in
    -i) interactive=1 ;;
    -e) shift; case "$1" in *=*) export "${1?}" ;; esac ;;   # bare `-e K`: K is already in our env
    ctb_postgres) shift; break ;;
    *) echo "stub: unexpected docker arg $1" >&2; exit 64 ;;
  esac
  shift
done
# The property under test. Real `docker exec -i` attaches stdin and drains it, so when stdin is the
# calling script the rest of that script lands here and the bash upstream runs out of input.
if [ "$interactive" = 1 ]; then cat >/dev/null; fi
echo "$1" >> /stub/calls                     # command name only: the arguments carry the secret
case "$1" in
  pg_isready) exit 0 ;;
  hostname) [ "${2:-}" = -i ] || { echo "stub: only 'hostname -i' is modelled" >&2; exit 64; }; echo "$PG_ADDR"; exit 0 ;;
  psql)
    sql="${*: -1}"                           # the -c statement is last in every call the script makes
    host=socket                              # no -h: psql uses the Unix socket
    while [ $# -gt 0 ]; do case "$1" in -h) host="$2"; shift ;; esac; shift; done
    case "$host" in                          # pg_hba.conf of the official image, see the header
      socket|127.*|localhost|::1) enforce=0 ;;
      "$PG_ADDR")                  enforce=1 ;;
      *) echo "stub: psql -h '$host' is not an address the fake container has" >&2; exit 64 ;;
    esac
    case "$sql" in
      *"ALTER ROLE ctb PASSWORD :'NEWPW'"*) echo "$NEWPW" > /stub/db-password; exit 0 ;;
      *"ALTER ROLE ctb PASSWORD :'OLDPW'"*) echo "$OLDPW" > /stub/db-password; exit 0 ;;
      *"SELECT 1"*) [ "$enforce" = 0 ] || [ "${PGPASSWORD:-}" = "$(cat /stub/db-password)" ] ;;
  psql)
    sql="${*: -1}"                           # the -c statement is last in every call the script makes
    case "$sql" in
      *"ALTER ROLE ctb PASSWORD :'NEWPW'"*) echo "$NEWPW" > /stub/db-password; exit 0 ;;
      *"ALTER ROLE ctb PASSWORD :'OLDPW'"*) echo "$OLDPW" > /stub/db-password; exit 0 ;;
      *"SELECT 1"*) [ "${PGPASSWORD:-}" = "$(cat /stub/db-password)" ] ;;
      *) echo "stub: unexpected sql" >&2; exit 64 ;;
    esac ;;
  *) echo "stub: unexpected command $1" >&2; exit 64 ;;
esac
EOF
cat > "$STUB/systemctl" <<'EOF'
#!/bin/bash
echo "systemctl $*" >> /stub/calls
[ "$1" = is-active ] && echo active
exit 0
EOF
chmod +x "$STUB/docker" "$STUB/systemctl"
export PATH="$STUB:$PATH"

# The invocation under test: the header's line, minus the ssh.
rc=0
out="$(bash -s < /vps/rotate-postgres-password.sh 2>&1)" || rc=$?
echo "--- script output (rc=$rc) ---"
while IFS= read -r line; do echo "  | $line"; done <<<"$out"
echo "--- calls ---"
sed 's/^/  | /' /stub/calls
echo "---"

[ "$rc" -eq 0 ] || fail "script exited $rc"
grep -q 'Previous .env is at' <<<"$out" || fail "script did not reach its last line (stdin was eaten)"
grep -q 'old password is refused' <<<"$out" || fail "two-way verification did not run"

new="$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
[ "${#new}" -eq 32 ] || fail ".env POSTGRES_PASSWORD is not a 32-character value"
[ "$new" != before_rotation ] || fail ".env POSTGRES_PASSWORD was not rotated"
grep -q "^DATABASE_URL=postgres://ctb:${new}@127.0.0.1:5433/ctb$" "$ENV_FILE" || fail "DATABASE_URL does not carry the new password"
grep -q '^FOO=bar$' "$ENV_FILE" || fail "unrelated .env line was disturbed"
[ "$(wc -l < "$ENV_FILE")" -eq 3 ] || fail ".env line count changed"
[ "$(stat -c '%a %U' "$ENV_FILE")" = "600 ctb" ] || fail ".env mode/owner wrong: $(stat -c '%a %U' "$ENV_FILE")"
[ "$(cat /stub/db-password)" = "$new" ] || fail "database and .env disagree on the password"
baks=("$ENV_FILE".bak-rotate-*)
[ "${#baks[@]}" -eq 1 ] || fail "expected exactly one .env backup, found ${#baks[@]}"
[ -f "${baks[0]}" ] || fail "no .env backup was written"
bak="${baks[0]}"
grep -q '^POSTGRES_PASSWORD=before_rotation$' "$bak" || fail "backup does not hold the previous .env"
expected=$'pg_isready\nhostname\npsql\npsql\npsql\nsystemctl restart ctb-collector\nsystemctl is-active ctb-collector'
expected=$'pg_isready\npsql\npsql\npsql\nsystemctl restart ctb-collector\nsystemctl is-active ctb-collector'
[ "$(cat /stub/calls)" = "$expected" ] || fail "call sequence differs from expected"

echo "PASS: rotate-postgres-password.sh completed under 'bash -s' and rotated .env and the (fake) database together"
