#!/bin/bash
#
# Proves infra/vps/alert-unit-failure.sh does what specs/001-vps-alerting/contracts/unit-failure-handler.md
# says, in a throwaway Linux container with `systemctl`, `systemd-escape`, `hostname` and `curl`
# replaced by stubs that RECORD what they were asked. The stubs reproduce the property under test
# rather than the happy path: the curl stub captures the exact --data-binary body and URL suffix, so
# a body that leaked the ping URL, or a suffix that went to the wrong endpoint, fails here and not on
# the box. (The lesson of 2026-09-16, #127/#130: a stand-in looser than production proves nothing.)
#
# Also runs `systemd-analyze verify` over infra/vps/systemd/* (step 7), because an OnFailure= line in
# the wrong section, or with a typo, never fires and nothing else would say so.
#
# Run on any machine with Docker:  infra/vps/test-alert-unit-failure.sh
# Exit 0 = every assertion held. Anything else = it did not, and the output says which.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" != "--inner" ]; then
  command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
  exec docker run --rm -v "$HERE:/vps:ro" debian:bookworm-slim bash /vps/test-alert-unit-failure.sh --inner
fi

# ---- inside the container from here --------------------------------------------------------------
fail() { echo "FAIL: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "inner must run as root"
[ -f /vps/alert-unit-failure.sh ] || fail "infra/vps/alert-unit-failure.sh does not exist"

# systemd-analyze for step 7. Debian slim has no systemd; install it. No network = no verdict, so die.
export DEBIAN_FRONTEND=noninteractive
if ! { apt-get -qq update >/dev/null 2>&1 && apt-get -qq install -y --no-install-recommends systemd >/dev/null 2>&1; }; then
  fail "could not install systemd for systemd-analyze verify; a check that cannot run is not a pass"
fi
command -v systemd-analyze >/dev/null || fail "systemd-analyze missing after install"

useradd -m ctb
REPO=/home/ctb/cardano-trading-bots
ENV_FILE="$REPO/.env"
mkdir -p "$REPO/infra/vps"
cp /vps/alert-unit-failure.sh "$REPO/infra/vps/alert-unit-failure.sh"
chmod 755 "$REPO/infra/vps/alert-unit-failure.sh"
# Placeholder URL: this is not a real check, and the assertions below prove it never leaves .env.
PING_URL='https://example.test/ping/0000stub0000'
printf 'FOO=bar\nCTB_HEALTHCHECK_URL=%s\nPOSTGRES_PASSWORD=not_a_real_secret_either\n' "$PING_URL" > "$ENV_FILE"
chown -R ctb:ctb /home/ctb; chmod 600 "$ENV_FILE"

STUB=/stub; mkdir -p "$STUB"; chmod 1777 "$STUB"   # the stubs run as ctb and must write here
for f in calls last-body last-url; do : > "$STUB/$f"; chmod 666 "$STUB/$f"; done

cat > "$STUB/systemctl" <<'EOF'
#!/bin/bash
# Fake `systemctl show -p Result -p ExecMainStatus -p NRestarts <unit>`; answers from STUB_* env.
echo "systemctl $*" >> /stub/calls
[ "${1:-}" = show ] || { echo "stub: only 'systemctl show' is modelled, got: ${1:-}" >&2; exit 64; }
printf 'Result=%s\nExecMainStatus=%s\nNRestarts=%s\n' "${STUB_RESULT:-exit-code}" "${STUB_STATUS:-1}" "${STUB_NRESTARTS:-0}"
EOF
cat > "$STUB/systemd-escape" <<'EOF'
#!/bin/bash
# Fake `systemd-escape --unescape <name>` with the REAL semantics: in systemd's escaping a "-" stands
# for "/", so unescaping a plain unit name mangles every hyphen. On 2026-09-16 the first live drill
# paged with "unit: ctb/paper@no/such/strategy.service" because the handler unescaped %i, and this
# stub had echoed names back unchanged -- looser than production, so the harness was green. The
# handler must not call this at all (%i is already the literal instance name); if it does, the
# body assertions below catch it.
[ "${1:-}" = --unescape ] || { echo "stub: only --unescape is modelled" >&2; exit 64; }
printf '%s\n' "${2//-//}"
EOF
cat > "$STUB/hostname" <<'EOF'
#!/bin/bash
echo stub-host
EOF
cat > "$STUB/curl" <<'EOF'
#!/bin/bash
# Fake curl. Records the URL SUFFIX after the base and the exact body, like the real service would
# see them. Honors -o <file> and -w '%{http_code}' the way the handler uses them.
echo "curl $*" >> /stub/calls
body=""; url=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --data-binary) shift; body="$1" ;;
    -o) shift; out="$1" ;;
    -w|-m|--retry|--retry-delay|-X) shift ;;
    -fsS|-s|-S|-f) ;;
    http*) url="$1" ;;
  esac
  shift
done
printf '%s\n' "$body" > /stub/last-body
printf '%s\n' "$url" > /stub/last-url
if [ "${STUB_CURL_FAIL:-0}" = 1 ]; then echo "curl: (6) Could not resolve host" >&2; exit 6; fi
[ -n "$out" ] && printf 'OK' > "$out"
printf '200'
EOF
chmod +x "$STUB"/systemctl "$STUB"/systemd-escape "$STUB"/hostname "$STUB"/curl

run_handler() {  # run_handler <unit> [ENV=VAL ...]
  local unit="$1"; shift
  : > /stub/last-body; : > /stub/last-url   # files are 666, so truncating as root keeps them writable by ctb
  su ctb -s /bin/bash -c "cd $REPO && PATH=$STUB:\$PATH $* ./infra/vps/alert-unit-failure.sh '$unit'" 2>&1 || return $?
}
suffix() { sed "s#^${PING_URL}##" /stub/last-url; }

echo "--- 1. start-limit-hit, exit 1 -> /1, body names unit/result/exit ---"
out="$(run_handler ctb-paper@ma-crossover.service STUB_RESULT=start-limit-hit STUB_STATUS=1 STUB_NRESTARTS=5)"; rc=$?
[ "$rc" -eq 0 ] || fail "1: handler exited $rc: $out"
[ "$(suffix)" = "/1" ] || fail "1: expected suffix /1, got '$(suffix)'"
grep -q '^unit: ctb-paper@ma-crossover.service$' /stub/last-body || fail "1: body lacks unit line: $(cat /stub/last-body)"
grep -q '^result: start-limit-hit$' /stub/last-body || fail "1: body lacks result line"
grep -q '^exit: 1$' /stub/last-body || fail "1: body lacks exit line"
grep -q '^restarts: 5$' /stub/last-body || fail "1: body lacks restarts line"
grep -q 'stub-host' /stub/last-body || fail "1: body lacks hostname"
echo "  ok"

echo "--- 2. active maintenance -> /log, reason in body ---"
until_iso="$(date -u -d '+30 min' +%Y-%m-%dT%H:%M:%SZ)"
printf '{"until":"%s","reason":"drill window","declaredAt":"%s","maxMinutes":240}\n' "$until_iso" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /home/ctb/ctb-maintenance.json
chown ctb:ctb /home/ctb/ctb-maintenance.json; chmod 600 /home/ctb/ctb-maintenance.json
out="$(run_handler ctb-collector.service STUB_RESULT=exit-code STUB_STATUS=2)"; rc=$?
[ "$rc" -eq 0 ] || fail "2: handler exited $rc: $out"
[ "$(suffix)" = "/log" ] || fail "2: expected suffix /log, got '$(suffix)'"
grep -q '^maintenance: drill window until ' /stub/last-body || fail "2: body lacks maintenance line: $(cat /stub/last-body)"
echo "  ok"

echo "--- 2b. EXPIRED maintenance file is ignored -> /2 ---"
printf '{"until":"%s","reason":"stale","declaredAt":"x"}\n' "$(date -u -d '-5 min' +%Y-%m-%dT%H:%M:%SZ)" > /home/ctb/ctb-maintenance.json
out="$(run_handler ctb-collector.service STUB_RESULT=exit-code STUB_STATUS=2)"; rc=$?
[ "$rc" -eq 0 ] || fail "2b: handler exited $rc: $out"
[ "$(suffix)" = "/2" ] || fail "2b: expected suffix /2 with an expired window, got '$(suffix)'"
rm -f /home/ctb/ctb-maintenance.json
echo "  ok"

echo "--- 3. non-numeric or zero exit status -> /fail ---"
out="$(run_handler ctb-backup.service STUB_RESULT=exit-code STUB_STATUS=0)"; rc=$?
[ "$rc" -eq 0 ] || fail "3: handler exited $rc: $out"
[ "$(suffix)" = "/fail" ] || fail "3: expected suffix /fail for status 0, got '$(suffix)'"
out="$(run_handler ctb-backup.service STUB_RESULT=signal STUB_STATUS=abc)"; rc=$?
[ "$(suffix)" = "/fail" ] || fail "3: expected suffix /fail for status abc, got '$(suffix)'"
echo "  ok"

echo "--- 4. no CTB_HEALTHCHECK_URL -> no curl, exit 0, log line ---"
cp "$ENV_FILE" "$ENV_FILE.keep"; printf 'FOO=bar\n' > "$ENV_FILE"; chown ctb:ctb "$ENV_FILE"; chmod 600 "$ENV_FILE"
before="$(grep -c '^curl ' /stub/calls || true)"
out="$(run_handler ctb-paper@buy-and-hold.service STUB_RESULT=start-limit-hit STUB_STATUS=1)"; rc=$?
[ "$rc" -eq 0 ] || fail "4: handler exited $rc without the key: $out"
after="$(grep -c '^curl ' /stub/calls || true)"
[ "$before" = "$after" ] || fail "4: curl was called without a URL"
grep -q 'alerting off' <<<"$out" || fail "4: expected an 'alerting off' log line, got: $out"
cp "$ENV_FILE.keep" "$ENV_FILE"; chown ctb:ctb "$ENV_FILE"; chmod 600 "$ENV_FILE"
echo "  ok"

echo "--- 5. the body and the handler's output never contain the URL or any .env value ---"
out="$(run_handler ctb-paper@ma-crossover.service STUB_RESULT=start-limit-hit STUB_STATUS=1)"
grep -q 'example.test' /stub/last-body && fail "5: body contains the ping URL host"
grep -q '0000stub0000' /stub/last-body && fail "5: body contains the ping URL path"
grep -q 'not_a_real_secret_either' /stub/last-body && fail "5: body contains another .env value"
grep -q '0000stub0000' <<<"$out" && fail "5: handler output contains the ping URL path: $out"
echo "  ok"

echo "--- 6. curl failure -> exit 0, log line says so ---"
out="$(run_handler ctb-collector.service STUB_RESULT=exit-code STUB_STATUS=1 STUB_CURL_FAIL=1)"; rc=$?
[ "$rc" -eq 0 ] || fail "6: handler must exit 0 when curl fails, exited $rc: $out"
grep -qE 'http (000|curl)' <<<"$out" || fail "6: expected a log line noting the failed send, got: $out"
echo "  ok"

echo "--- 7. systemd-analyze verify over infra/vps/systemd/* ---"
mkdir -p /etc/systemd/system
cp /vps/systemd/*.service /vps/systemd/*.timer /etc/systemd/system/
# Verify from the installed location so template instances resolve. Warnings are printed; errors fail.
if ! systemd-analyze verify /etc/systemd/system/ctb-*.service /etc/systemd/system/ctb-*.timer 2>&1 | tee /stub/verify.out | grep -qiE 'error|failed to|unknown (key|section)|not found'; then
  echo "  ok (no errors)"
else
  # systemd-analyze exits 0 on some errors and prints them; treat any error-looking line as a failure.
  if grep -qiE 'unknown (key|section)|failed to (parse|load)|invalid' /stub/verify.out; then
    cat /stub/verify.out; fail "7: systemd-analyze verify reported an error"
  fi
  echo "  ok (verify output had no unit errors; see above if warnings)"
fi
for u in ctb-paper@.service ctb-collector.service ctb-backup.service; do
  grep -qE '^OnFailure=ctb-alert@%n\.service$' "/vps/systemd/$u" || fail "7: $u lacks OnFailure=ctb-alert@%n.service"
  awk '/^\[Unit\]/{u=1;next} /^\[/{u=0} u && /^OnFailure=/{found=1} END{exit found?0:1}' "/vps/systemd/$u" \
    || fail "7: OnFailure= in $u is not inside [Unit] (systemd would silently ignore it)"
done
grep -q '^OnFailure=' /vps/systemd/ctb-alert@.service && fail "7: ctb-alert@.service must not have OnFailure= (it would loop)"
echo "  ok"

echo "PASS: alert-unit-failure.sh sends the right suffix and body, honours maintenance, never leaks the URL, never fails the unit, and the units verify"
