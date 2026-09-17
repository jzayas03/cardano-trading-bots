#!/bin/bash
#
# Proves infra/vps/paper-start.sh routes the right STRATEGY and the right TICKER to the runner,
# and that the runner is node with the tsx hooks -- no `npm run`, no `tsx` bin.
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
# Everything is stubbed except bash: `psql` (which decides resume vs new) and `node` (which records
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

# The runner records exactly what it was asked to run and exits 0. The script `exec`s it, so this is
# the last thing that happens and the file is the whole verdict.
#
# The stub has to BE the real runner, and the real runner keeps changing: it was `npm` until
# 2026-09-16, then `node_modules/.bin/tsx`, and is now `node` with two hook flags. Each time, a stub
# left pointing at the old name would never be called and every assertion below would pass against
# an empty file -- proving nothing, loudly. So the stub is `node`, and steps 8 and 9 pin the two
# retired runners as never-called.
cat > "$STUB/node" <<'NODEEOF'
#!/bin/bash
printf '%s\n' "$*" > "$ARGV_FILE"
NODEEOF
chmod +x "$STUB/node"

# paper-start.sh refuses to run if tsx is not installed, so the guard needs something to find.
mkdir -p "$REPO/node_modules/tsx"
printf '{"name":"tsx"}\n' > "$REPO/node_modules/tsx/package.json"

# The retired `tsx` bin, kept only so step 9 can prove it is never invoked.
mkdir -p "$REPO/node_modules/.bin"
cat > "$REPO/node_modules/.bin/tsx" <<'TSXEOF'
#!/bin/bash
printf 'tsx bin was called: %s\n' "$*" > "$TSX_CALLED_FILE"
TSXEOF
chmod +x "$REPO/node_modules/.bin/tsx"

# Every routing assertion below is about the strategy and the ticker, so the invariant part of the
# command line lives here. Step 10 asserts the hooks themselves.
HOOKS="--require tsx/preflight --import tsx"

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

export PATH="$STUB:$PATH"
export ARGV_FILE="$ARGV"
TSX_CALLED="$WORK/tsx-called"
export TSX_CALLED_FILE="$TSX_CALLED"
: > "$TSX_CALLED"

run() { : > "$ARGV"; ( cd "$WORK" && "$REPO/infra/vps/paper-start.sh" "$@" ) >/dev/null 2>&1; }
argv() { cat "$ARGV"; }

echo "1. the instance form splits strategy from ticker"
write_psql_empty
run ma-crossover_SNEK --max-gap-min 20
[ "$(argv)" = "$HOOKS packages/cli/src/main.ts paper ma-crossover SNEK --max-gap-min 20" ] || fail "1: got '$(argv)'"
pass "ma-crossover_SNEK -> ma-crossover SNEK"

echo "2. a hyphenated strategy survives the split (the whole reason the separator is not a hyphen)"
for pair in "rsi-mean-reversion_NIGHT:rsi-mean-reversion NIGHT" \
            "buy-and-hold_MIN:buy-and-hold MIN" \
            "scheduled-accumulation_NIGHT:scheduled-accumulation NIGHT"; do
  inst="${pair%%:*}"; want="${pair#*:}"
  run "$inst" --max-gap-min 20
  [ "$(argv)" = "$HOOKS packages/cli/src/main.ts paper $want --max-gap-min 20" ] || fail "2: $inst gave '$(argv)'"
done
pass "three hyphenated strategies split on the LAST underscore"

echo "3. the two-argument form still works, so a human can call it by hand"
run ma-crossover SNEK --max-gap-min 20
[ "$(argv)" = "$HOOKS packages/cli/src/main.ts paper ma-crossover SNEK --max-gap-min 20" ] || fail "3: got '$(argv)'"
pass "explicit <strategy> <TICKER> unchanged"

echo "4. THE ONE THAT MATTERS: a mis-named instance FAILS, it does not trade the wrong thing"
# Without a ticker, `--max-gap-min` would have been taken as the token. A paper run against a token
# called "--max-gap-min" does not error loudly; it produces a clean, wrong equity curve.
: > "$ARGV"   # clear FIRST: an uncleared file made this assert against the PREVIOUS step's argv
if ( cd "$WORK" && "$REPO/infra/vps/paper-start.sh" ma-crossover --max-gap-min 20 ) >/dev/null 2>&1; then
  fail "4: a ticker-less instance was accepted"
fi
[ ! -s "$ARGV" ] || fail "4: the runner was invoked anyway with '$(argv)'"
pass "ticker-less instance refused, runner never called"

echo "5. a value that is not a ticker is refused too"
: > "$ARGV"
for bad in ma-crossover_snek ma-crossover_ ma-crossover_--max-gap-min; do
  if ( cd "$WORK" && "$REPO/infra/vps/paper-start.sh" "$bad" --max-gap-min 20 ) >/dev/null 2>&1; then
    fail "5: '$bad' was accepted"
  fi
done
[ ! -s "$ARGV" ] || fail "5: the runner was invoked with '$(argv)'"
pass "lowercase, empty and flag-shaped tickers all refused"

echo "6. the TICKER reaches the resume query, not just the paper command"
write_psql_resume
run rsi-mean-reversion_NIGHT --max-gap-min 20
grep -q -- "-v ticker=NIGHT" "$WORK/psql-argv" || fail "6: psql got '$(cat "$WORK/psql-argv")'"
grep -q -- "-v strategy=rsi-mean-reversion" "$WORK/psql-argv" || fail "6: strategy missing"
[ "$(argv)" = "$HOOKS packages/cli/src/main.ts paper rsi-mean-reversion NIGHT --resume 77 --max-gap-min 20" ] || fail "6: got '$(argv)'"
pass "resume matches on strategy AND ticker, and resumes that run"

echo "7. CTB_PAPER_FORCE_NEW skips the resume lookup but keeps the token"
: > "$ARGV"
( cd "$WORK" && CTB_PAPER_FORCE_NEW=1 "$REPO/infra/vps/paper-start.sh" buy-and-hold_MIN --max-gap-min 20 ) >/dev/null 2>&1
[ "$(argv)" = "$HOOKS packages/cli/src/main.ts paper buy-and-hold MIN --max-gap-min 20" ] || fail "7: got '$(argv)'"
pass "force-new still carries the right token"

echo "8. the npm wrapper is gone, not merely bypassed"
# A stub `npm` that is never called is the proof. If paper-start.sh ever goes back through
# `npm run`, this file gets written and ~18 MB of wrapper per run comes back with it. (That figure
# was first reported as 67 MB per run: it was RSS, which counts the shared node binary once per
# process. Private_Dirty is the honest one.)
NPM_CALLED="$WORK/npm-called"
cat > "$STUB/npm" <<'NPMEOF'
#!/bin/bash
printf 'npm was called: %s\n' "$*" > "$NPM_CALLED_FILE"
NPMEOF
chmod +x "$STUB/npm"
export NPM_CALLED_FILE="$NPM_CALLED"
: > "$NPM_CALLED"
write_psql_empty
run ma-crossover_SNEK --max-gap-min 20
[ ! -s "$NPM_CALLED" ] || fail "8: $(cat "$NPM_CALLED")"
pass "npm was never invoked"

echo "9. the tsx bin is gone too, not merely bypassed"
# Same proof, one layer down. `node_modules/.bin/tsx` does nothing but re-exec node with the hook
# flags, so going back through it would add a 14.5 MB process per run for no behaviour.
#
# Proved by negative control before this was committed: adding `"$REPO/node_modules/.bin/tsx"
# --version` to the guard in paper-start.sh -- a plausible "check the install works" edit that
# leaves every routing assertion above untouched -- passed eight steps and failed here.
[ ! -s "$TSX_CALLED" ] || fail "9: $(cat "$TSX_CALLED")"
pass "the tsx bin was never invoked"

echo "10. BOTH hooks are passed, not just the loader"
# `--import tsx` alone handles ESM and runs the app fine. What it drops is tsx/preflight, which
# installs the signal handlers -- and systemd stops these runs with SIGTERM, so the regression is
# invisible until a stop behaves differently on a live run.
#
# This hardcodes the literal where the assertions above use $HOOKS, and that is the whole point:
# someone dropping a hook would naturally update $HOOKS to match and make steps 1-7 green again.
# Proved by negative control before this was committed: doing exactly that passed nine steps and
# failed here.
run ma-crossover_SNEK --max-gap-min 20
case "$(argv)" in
  "--require tsx/preflight --import tsx "*) ;;
  *) fail "10: hooks wrong or missing: '$(argv)'" ;;
esac
pass "node is invoked with --require tsx/preflight AND --import tsx"

echo
echo "PASS: all ten steps held."
