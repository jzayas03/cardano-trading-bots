#!/bin/bash
#
# Proves infra/vps/paper-start.sh routes the right STRATEGY and the right TICKER to `npm run paper`.
#
# Why this harness exists. The ticker used to be hardcoded as `SNEK` in `ctb-paper@.service`'s
# ExecStart, so every instance of that template traded the same token and a second instrument was
# impossible. `%i` is the only thing systemd hands a template, so the instance name now carries both
# parts as `<strategy>_<TICKER>` and this script splits them.
#
# The split is the dangerous part. Every strategy id contains hyphens (`ma-crossover`,
# `rsi-mean-reversion`, `buy-and-hold`, `scheduled-accumulation`), so a wrong separator or a
# first-underscore split silently produces a plausible-looking strategy and a wrong token -- and a
# paper run against the wrong token does not error, it produces a clean, wrong equity curve. Step 4
# is the one that matters: a mis-named instance must FAIL, never trade something.
#
# Everything is stubbed except bash: `psql` (which decides resume vs new) and `npm` (which records
# the argv it was called with). No database, no network, no Node.
#
# Run on any machine with Docker:  infra/vps/test-paper-start.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" != "--inner" ]; then
  command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
  exec docker run --rm -v "$HERE:/vps:ro" debian:stable-slim bash /vps/test-paper-start.sh --inner
fi

# ---- inside the container from here --------------------------------------------------------------
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

WORK="$(mktemp -d)"
REPO="$WORK/cardano-trading-bots"
STUB="$WORK/bin"
mkdir -p "$REPO/infra/vps" "$STUB"
cp /vps/paper-start.sh "$REPO/infra/vps/paper-start.sh"
chmod +x "$REPO/infra/vps/paper-start.sh"
: > "$REPO/infra/vps/resume-target.sql"
printf 'DATABASE_URL=postgres://stub\n' > "$REPO/.env"

ARGV="$WORK/argv"

# `npm` records exactly what it was asked to run and exits 0. The script `exec`s it, so this is the
# last thing that happens and the file is the whole verdict.
cat > "$STUB/npm" <<'NPMEOF'
#!/bin/bash
printf '%s\n' "$*" > "$ARGV_FILE"
NPMEOF

# `psql` decides whether there is a run to resume. Default: nothing to resume.
write_psql_empty() { printf '#!/bin/bash\nexit 0\n' > "$STUB/psql"; chmod +x "$STUB/psql"; }
# A resumable row, and it records the -v bindings so we can prove the TICKER reached the query.
write_psql_resume() {
  cat > "$STUB/psql" <<PSQLEOF
#!/bin/bash
printf '%s\n' "\$*" > "$WORK/psql-argv"
echo '77|running||'
PSQLEOF
  chmod +x "$STUB/psql"
}

chmod +x "$STUB/npm"
export PATH="$STUB:$PATH"
export ARGV_FILE="$ARGV"

run() { : > "$ARGV"; ( cd "$WORK" && "$REPO/infra/vps/paper-start.sh" "$@" ) >/dev/null 2>&1; }
argv() { cat "$ARGV"; }

echo "1. the instance form splits strategy from ticker"
write_psql_empty
run ma-crossover_SNEK --max-gap-min 20
[ "$(argv)" = "run paper -- ma-crossover SNEK --max-gap-min 20" ] || fail "1: got '$(argv)'"
pass "ma-crossover_SNEK -> ma-crossover SNEK"

echo "2. a hyphenated strategy survives the split (the whole reason the separator is not a hyphen)"
for pair in "rsi-mean-reversion_NIGHT:rsi-mean-reversion NIGHT" \
            "buy-and-hold_MIN:buy-and-hold MIN" \
            "scheduled-accumulation_NIGHT:scheduled-accumulation NIGHT"; do
  inst="${pair%%:*}"; want="${pair#*:}"
  run "$inst" --max-gap-min 20
  [ "$(argv)" = "run paper -- $want --max-gap-min 20" ] || fail "2: $inst gave '$(argv)'"
done
pass "three hyphenated strategies split on the LAST underscore"

echo "3. the two-argument form still works, so a human can call it by hand"
run ma-crossover SNEK --max-gap-min 20
[ "$(argv)" = "run paper -- ma-crossover SNEK --max-gap-min 20" ] || fail "3: got '$(argv)'"
pass "explicit <strategy> <TICKER> unchanged"

echo "4. THE ONE THAT MATTERS: a mis-named instance FAILS, it does not trade the wrong thing"
# Without a ticker, `--max-gap-min` would have been taken as the token. A paper run against a token
# called "--max-gap-min" does not error loudly; it produces a clean, wrong equity curve.
: > "$ARGV"   # clear FIRST: an uncleared file made this assert against the PREVIOUS step's argv
if ( cd "$WORK" && "$REPO/infra/vps/paper-start.sh" ma-crossover --max-gap-min 20 ) >/dev/null 2>&1; then
  fail "4: a ticker-less instance was accepted"
fi
[ ! -s "$ARGV" ] || fail "4: npm was invoked anyway with '$(argv)'"
pass "ticker-less instance refused, npm never called"

echo "5. a value that is not a ticker is refused too"
: > "$ARGV"
for bad in ma-crossover_snek ma-crossover_ ma-crossover_--max-gap-min; do
  if ( cd "$WORK" && "$REPO/infra/vps/paper-start.sh" "$bad" --max-gap-min 20 ) >/dev/null 2>&1; then
    fail "5: '$bad' was accepted"
  fi
done
[ ! -s "$ARGV" ] || fail "5: npm was invoked with '$(argv)'"
pass "lowercase, empty and flag-shaped tickers all refused"

echo "6. the TICKER reaches the resume query, not just the paper command"
write_psql_resume
run rsi-mean-reversion_NIGHT --max-gap-min 20
grep -q -- "-v ticker=NIGHT" "$WORK/psql-argv" || fail "6: psql got '$(cat "$WORK/psql-argv")'"
grep -q -- "-v strategy=rsi-mean-reversion" "$WORK/psql-argv" || fail "6: strategy missing"
[ "$(argv)" = "run paper -- rsi-mean-reversion NIGHT --resume 77 --max-gap-min 20" ] || fail "6: got '$(argv)'"
pass "resume matches on strategy AND ticker, and resumes that run"

echo "7. CTB_PAPER_FORCE_NEW skips the resume lookup but keeps the token"
: > "$ARGV"
( cd "$WORK" && CTB_PAPER_FORCE_NEW=1 "$REPO/infra/vps/paper-start.sh" buy-and-hold_MIN --max-gap-min 20 ) >/dev/null 2>&1
[ "$(argv)" = "run paper -- buy-and-hold MIN --max-gap-min 20" ] || fail "7: got '$(argv)'"
pass "force-new still carries the right token"

echo
echo "PASS: all seven steps held."
