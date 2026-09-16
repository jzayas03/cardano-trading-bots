# CLAUDE.md — cardano-trading-bots

Project-specific guidance for Claude Code. The global `~/.claude/CLAUDE.md` applies on top of
this file. Multi-step feature work uses the `speckit-*` skills in `.claude/skills/`.

## Memory (5 layers — procedure: `memory-layers` skill)

Working (context; `/context-save`) → Episodic (`episodes.md`, one dated line per session) →
Semantic (`user_*`/`project_*`) → Procedural (`feedback_*`, skills) → Pruning (index ≤ 60 lines,
episodes ≤ 40, newer dated fact wins). Retrieve from the index plus ≤ 3 files, never raw history.
Write back at every session end. Memory data stays in the harness dir; no secrets in it, ever.
