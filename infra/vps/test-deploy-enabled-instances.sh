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

# Steps 1-4 test paper_wants() and the comparison IN ISOLATION, and every one of them passed while
# deploy.sh was broken: step 4 removes the leftover by hand and then checks, so it never runs the
# script's real sequence. The post-check sat BETWEEN the disable loop and `systemctl enable`, so it
# could only pass when the desired set already existed -- it passed when there was nothing to do and
# died whenever there was, and a cutover is the only time there is. Found 2026-09-18 by rehearsing
# the real transition; this step is that rehearsal, kept.
#
# It lifts the whole block out of deploy.sh at run time and runs it IN SCRIPT ORDER against a stub
# systemctl that really creates and removes the wants symlinks, so the post-check sees what the
# script actually left behind rather than what a test arranged.
echo "5. the REAL cutover transition, in script order: four old names enabled -> the file's eight"
ROOT5="$(mktemp -d)"; W5="$ROOT5/wants"; mkdir -p "$W5" "$ROOT5/repo/infra"
ln -s /vps "$ROOT5/repo/infra/vps"
# The box's enabled set as read off it on 2026-09-18: four instances under the pre-rename names.
for u in ma-crossover rsi-mean-reversion buy-and-hold scheduled-accumulation; do
  ln -s /dev/null "$W5/ctb-paper@$u.service"
done
ln -s /dev/null "$W5/ctb-collector.service"

# `|| true` so a missing anchor yields an EMPTY value the guard below can report. Without it,
# `set -euo pipefail` kills the script on grep's no-match exit before the guard runs: the harness still
# fails closed, but silently, with no reason printed. Found by breaking the anchor on purpose.
start="$(grep -n '^INSTANCES_FILE=' /vps/deploy.sh | head -1 | cut -d: -f1 || true)"
end="$(grep -n 'enabled for boot matches paper-instances.txt' /vps/deploy.sh | head -1 | cut -d: -f1 || true)"
if [ -z "$start" ] || [ -z "$end" ]; then fail "5: could not locate the instances block in deploy.sh"; fi
BLOCK5="$(sed -n "${start},${end}p" /vps/deploy.sh | sed "s|^WANTS_DIR=.*|WANTS_DIR=$W5|")"

# Run it as its OWN bash process, the way deploy.sh runs, rather than eval'ing it here: the stubs
# live in a quoted heredoc, so the block cannot see or clobber anything in this harness.
{
  printf 'REPO=%q\nNO_START=1\nW5=%q\n' "$ROOT5/repo" "$W5"
  cat <<'STUBS'
die() { echo "DIE: $*"; exit 9; }
# Changes the wants directory exactly as systemd would, so the post-check sees what the script
# actually left behind rather than what a test arranged.
systemctl() {
  local verb="${1:-}"; shift || true
  case "$verb" in
    disable) for u in "$@"; do rm -f "$W5/$u"; done ;;
    enable)  for u in "$@"; do case "$u" in ctb-paper@*|ctb-collector.service) ln -sf /dev/null "$W5/$u" ;; esac; done ;;
  esac
  return 0
}
STUBS
  printf '%s\n' "$BLOCK5"
  echo 'echo BLOCK-COMPLETED'
} > "$ROOT5/run.sh"

set +e
out5="$(bash "$ROOT5/run.sh" 2>&1)"
rc5=$?
set -e

if [ "$rc5" != "0" ] || ! echo "$out5" | grep -q BLOCK-COMPLETED; then
  fail "5: deploy.sh's instances block did not complete (exit $rc5) -- $(echo "$out5" | grep DIE || echo "$out5" | tail -1)"
fi
disabled5="$(echo "$out5" | grep -c 'disabling for boot' || true)"
[ "$disabled5" = "4" ] || fail "5: expected the four old-named instances disabled, got $disabled5"
after5="$( (shopt -s nullglob; for f in "$W5"/ctb-paper@*.service; do basename "$f"; done) | sort | tr '\n' ' ')"
want5="$(grep -v '^#' /vps/paper-instances.txt | sed 's/[[:space:]]//g' | grep -v '^$' | sed 's/.*/ctb-paper@&.service/' | sort | tr '\n' ' ')"
[ "$after5" = "$want5" ] || fail "5: enabled after deploy is '$after5', want '$want5'"
# Every current name carries a _TICKER suffix; an unsuffixed one is a pre-rename survivor. A `case`
# rather than a regex: CI's shellcheck is older and misreads some patterns inside [[ =~ ]].
for f in "$W5"/ctb-paper@*.service; do
  n="$(basename "$f")"
  case "$n" in *_*) ;; *) fail "5: an OLD unsuffixed instance survived the deploy: $n" ;; esac
done
pass "four old names disabled, the file's eight enabled, no survivor, and the post-check accepted it"

echo
echo "PASS: all five steps held."
