#!/bin/bash
#
# Proves deploy.sh can SEE which ctb-paper@ template instances are enabled for boot, and refuses a
# deploy that would leave the wrong set enabled.
#
# Why this harness exists. deploy.sh disables any enabled instance that paper-instances.txt does not
# name. Without that, renaming `ctb-paper@ma-crossover` to `ctb-paper@ma-crossover_SNEK` leaves BOTH
# enabled and the next reboot starts twelve paper processes on a box that fits eight -- an OOM
# discovered by reboot. That protection was fed by `systemctl list-unit-files --state=enabled`, which
# lists unit FILES: a template has exactly one file, and enabling an INSTANCE writes a symlink into
# the wants directory instead. On the live box 2026-09-17 it returned 0 while four instances were
# enabled, so the loop had never executed once in its entire existence.
#
# The function under test is taken OUT of deploy.sh at run time rather than copied, so it cannot
# drift from the thing that actually runs.
#
# Run on any machine with Docker:  infra/vps/test-deploy-enabled-instances.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" != "--inner" ]; then
  command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
  exec docker run --rm -v "$HERE:/vps:ro" debian:stable-slim bash /vps/test-deploy-enabled-instances.sh --inner
fi

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

# Lift paper_wants() verbatim from deploy.sh. If the definition ever moves or is renamed, this
# harness dies here rather than testing a stale copy of it.
DEF="$(grep -E '^paper_wants\(\) \(' /vps/deploy.sh || true)"
[ -n "$DEF" ] || fail "paper_wants() not found in deploy.sh -- it was renamed or removed"
WORK="$(mktemp -d)"
WANTS_DIR="$WORK/wants"; mkdir -p "$WANTS_DIR"
eval "$DEF"

# Step 1 passes under the BROKEN enumeration too -- an empty directory and a command that returns
# nothing are indistinguishable. Step 2 is the discriminator, and its absence is why the old code
# looked fine for its whole life. Proved by negative control before this was committed: replacing
# paper_wants with one that returns nothing (what list-unit-files did on the box) passes step 1 and
# fails step 2 with `got '' want 'ctb-paper@buy-and-hold_SNEK.service ...'`.
echo "1. an empty wants directory enumerates to nothing, and does not error"
out="$(paper_wants)"
[ -z "$out" ] || fail "1: expected empty, got '$out'"
pass "empty wants dir -> no output, no glob literal (nullglob is on)"

echo "2. enabled instances ARE found -- the whole point, and what the old command could not do"
for u in ma-crossover_SNEK rsi-mean-reversion_SNEK buy-and-hold_SNEK; do
  ln -s "/etc/systemd/system/ctb-paper@.service" "$WANTS_DIR/ctb-paper@$u.service"
done
# a non-paper unit must not be swept up
ln -s /dev/null "$WANTS_DIR/ctb-collector.service"
got="$(paper_wants | sort | tr '\n' ' ')"
want="ctb-paper@buy-and-hold_SNEK.service ctb-paper@ma-crossover_SNEK.service ctb-paper@rsi-mean-reversion_SNEK.service "
[ "$got" = "$want" ] || fail "2: got '$got' want '$want'"
pass "three instances found by symlink, and ctb-collector.service is not one of them"

# The comparison deploy.sh makes after disabling. Same shape, so a mismatch here is a mismatch there.
check() {
  local enabled_now want_now
  enabled_now="$(paper_wants | sort | tr '\n' ' ')"
  want_now="$(printf '%s\n' "$@" | sort | tr '\n' ' ')"
  [ "$enabled_now" = "$want_now" ]
}

echo "3. a LEFTOVER old-named instance is caught, not silently carried into the reboot"
ln -s "/etc/systemd/system/ctb-paper@.service" "$WANTS_DIR/ctb-paper@ma-crossover.service"
if check ctb-paper@ma-crossover_SNEK.service ctb-paper@rsi-mean-reversion_SNEK.service ctb-paper@buy-and-hold_SNEK.service; then
  fail "3: the pre-rename ctb-paper@ma-crossover was enabled and the check passed anyway"
fi
pass "the exact #168 rename failure is refused"

echo "4. and it passes when the enabled set matches the file exactly"
rm "$WANTS_DIR/ctb-paper@ma-crossover.service"
check ctb-paper@ma-crossover_SNEK.service ctb-paper@rsi-mean-reversion_SNEK.service ctb-paper@buy-and-hold_SNEK.service \
  || fail "4: a matching set was rejected"
pass "matching set accepted"

echo
echo "PASS: all four steps held."
