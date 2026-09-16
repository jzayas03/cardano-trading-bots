# CLAUDE.md — cardano-trading-bots

Project-specific guidance for Claude Code. The global `~/.claude/CLAUDE.md` applies on top of
this file. Multi-step feature work uses the `speckit-*` skills in `.claude/skills/`.

## Memory (5 layers — procedure: `memory-layers` skill)

Working (context; `/context-save`) → Episodic (`episodes.md`, one dated line per session) →
Semantic (`user_*`/`project_*`) → Procedural (`feedback_*`, skills) → Pruning (index ≤ 1,500 words,
episodes ≤ 40, newer dated fact wins). Retrieve from the index plus ≤ 3 files, never raw history.
Write back at every session end. Memory data stays in the harness dir; no secrets in it, ever.

## Traps (one line each; `git log -S` for the story)

- **CI's shellcheck is older than the local one.** A `}` inside `[[ =~ ]]` (any `{n}` quantifier)
  is read as a command-group close and fails only in CI (SC1046/SC1047 at a later `if`). Write shell
  regexes brace-free: `^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$`, not `([0-9]+\.){3}` (2026-09-16, #128).
- **GitHub's "Update branch" can keep both sides of a conflict** and it still looks like an ordinary
  merge commit. Before pushing to a branch that was updated from `main` in the UI, `git fetch` and
  diff the remote branch against your last verified tree; fix forward, never force-push over the
  founder's commit (2026-09-16, #128: verification block, stub body and expected list each doubled).
