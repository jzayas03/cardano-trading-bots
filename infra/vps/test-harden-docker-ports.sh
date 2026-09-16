#!/bin/bash
#
# Proves infra/vps/harden-docker-ports.sh survives the delivery method its own header prescribes:
#
#   ssh root@<ip> 'bash -s' < infra/vps/harden-docker-ports.sh
#
# Under `bash -s` the script IS bash's stdin, so any child that reads stdin eats the rest of the
# script and bash exits 0 having done only part of the job. That is not hypothetical here: the
# Postgres rotate script did exactly this on the VPS on 2026-09-16 and reported success while
# rotating nothing (#127). `ufw reload` shells out to iptables-restore, which reads stdin by
# default, so this script is in the same family.
#
# The `ufw` stub below therefore DRAINS STDIN, exactly like the real one's child does. A stand-in
# that is politer than production proves nothing. Step 6 is the control that keeps this honest: it
# strips `</dev/null` off the reload line and requires the harness to NOTICE -- if step 6 ever
# passes, the harness has stopped testing the thing it exists for.
#
# Everything here is a stub except bash, sed, grep and cp: the real script needs root, ufw and
# netfilter, none of which belong in CI. What is being tested is the script's control flow and its
# refusal to report success on a half-application, not netfilter semantics.
#
# Run on any machine with Docker:  infra/vps/test-harden-docker-ports.sh
# Exit 0 = all six steps held. Anything else = they did not.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" != "--inner" ]; then
  command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
  exec docker run --rm -v "$HERE:/vps:ro" debian:stable-slim bash /vps/test-harden-docker-ports.sh --inner
fi

# ---- inside the container from here --------------------------------------------------------------
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }
[ "$(id -u)" -eq 0 ] || fail "inner must run as root"

SCRIPT=/vps/harden-docker-ports.sh
[ -r "$SCRIPT" ] || fail "cannot read $SCRIPT"

WORK="$(mktemp -d)"
STUB="$WORK/bin"
APPLIED="$WORK/applied"          # what the fake netfilter currently holds
mkdir -p "$STUB" /etc/ufw
: > "$APPLIED"

seed_after_rules() {
  rm -f /etc/ufw/after.rules.bak-*
  cat > /etc/ufw/after.rules <<'RULES'
# stand-in for ufw's shipped after.rules
*filter
:ufw-after-input - [0:0]
COMMIT
RULES
}

# `ip route get 1.1.1.1` is the only form the script uses.
cat > "$STUB/ip" <<'IPEOF'
#!/bin/bash
echo "1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.2 uid 0"
IPEOF

# A ufw that reloads for real: drains stdin (as iptables-restore does), then applies what is in
# after.rules to the fake chain.
write_ufw_applying() {
  cat > "$STUB/ufw" <<UFWEOF
#!/bin/bash
cat >/dev/null
grep '^-A DOCKER-USER' /etc/ufw/after.rules > "$APPLIED" || true
echo "Firewall reloaded"
UFWEOF
  chmod +x "$STUB/ufw"
}

# A ufw that succeeds loudly and applies nothing -- the silent half-application the script must catch.
write_ufw_noop() {
  cat > "$STUB/ufw" <<UFWEOF
#!/bin/bash
cat >/dev/null
: > "$APPLIED"
echo "Firewall reloaded"
UFWEOF
  chmod +x "$STUB/ufw"
}

cat > "$STUB/iptables" <<IPTEOF
#!/bin/bash
cat "$APPLIED"
IPTEOF

chmod +x "$STUB/ip" "$STUB/iptables"
export PATH="$STUB:$PATH"

LAST_LINE="docker exec -i ctb_postgres psql -U ctb -d ctb -At -c 'SELECT 1'"
blocks() { grep -c '^# BEGIN ctb docker-port hardening' /etc/ufw/after.rules || true; }

echo "1. clean install, delivered the way the runbook delivers it"
seed_after_rules
write_ufw_applying
out="$(bash -s < "$SCRIPT" 2>&1)" || fail "script exited non-zero on a clean install: $out"
printf '%s\n' "$out" | grep -qF "$LAST_LINE" \
  || fail "script did not reach its final line -- something ate stdin. Output was: $out"
pass "reached the last line under bash -s"
printf '%s\n' "$out" | grep -q 'both DROP rules confirmed live' || fail "no live-rule confirmation"
pass "confirmed both DROP rules live"

echo "2. the block and the backup landed"
[ "$(blocks)" = "1" ] || fail "expected exactly 1 marked block, got $(blocks)"
grep -q 'dport 5432 -j DROP' /etc/ufw/after.rules || fail "5432 DROP missing from after.rules"
grep -q 'dport 5433 -j DROP' /etc/ufw/after.rules || fail "5433 DROP missing from after.rules"
grep -q -- '-i eth0' /etc/ufw/after.rules || fail "the DROPs are not scoped to the public interface"
pass "both DROPs present and scoped to eth0"
ls /etc/ufw/after.rules.bak-* >/dev/null 2>&1 || fail "no timestamped backup of after.rules"
pass "after.rules backed up before the edit"

echo "3. host and container traffic are NOT dropped"
grep -q -- '-i lo' /etc/ufw/after.rules && fail "the block touches loopback; paper runs reach pg on 127.0.0.1"
grep -q 'RETURN' /etc/ufw/after.rules || fail "the chain does not RETURN; everything else would fall through"
pass "loopback untouched, chain returns"

echo "4. idempotent: a second run leaves one block, not two"
out="$(bash -s < "$SCRIPT" 2>&1)" || fail "second run exited non-zero: $out"
[ "$(blocks)" = "1" ] || fail "second run left $(blocks) blocks"
printf '%s\n' "$out" | grep -q 'already installed' || fail "second run did not report re-installing"
pass "still exactly one block"

echo "5. a reload that applies nothing must FAIL, not report success"
seed_after_rules
write_ufw_noop
if out="$(bash -s < "$SCRIPT" 2>&1)"; then
  fail "script reported success while the rules were not loaded. Output was: $out"
fi
printf '%s\n' "$out" | grep -q 'missing the DROP' || fail "failed, but not with the expected message: $out"
pass "half-application refused"

echo "6. control: the harness must NOTICE if the stdin guard is removed"
seed_after_rules
write_ufw_applying
sed 's|^ufw reload </dev/null$|ufw reload|' "$SCRIPT" > "$WORK/unguarded.sh"
cmp -s "$SCRIPT" "$WORK/unguarded.sh" && fail "the control did not change anything; has the reload line been renamed?"
out="$(bash -s < "$WORK/unguarded.sh" 2>&1)" || true
if printf '%s\n' "$out" | grep -qF "$LAST_LINE"; then
  fail "an unguarded reload still reached the last line -- this harness no longer tests the stdin trap"
fi
pass "unguarded reload loses the rest of the script, as it must"

echo
echo "PASS: all six steps held."
