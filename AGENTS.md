# AGENTS.md — cardano-trading-bots

Project-specific guidance for Codex. The global `~/.Codex/AGENTS.md` applies on top of
this file. Multi-step feature work uses the `speckit-*` skills in `.Codex/skills/`.

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
- **Never run one alerting drill inside another's maintenance window, and read the endpoint, not the
  status.** A suppressed alert and a delivered one differ by four characters in `alert.log` --
  `-> /log` vs `-> /1` -- and BOTH read `http 200 OK`, so a drill that proved nothing looks exactly
  like one that passed (2026-09-16, #152: drill 3b ran 10 s inside drill 4b's window).
- **Never size a box from summed RSS.** RSS counts the shared node binary once per process, so
  summing it across ten node processes charges the same pages ten times: the `npm` wrapper read as
  67 MB per run when it really cost 18.4, and that went into a runbook as a 267 MB saving when it
  was ~74. What one more instance costs is `Private_Dirty` in `/proc/PID/smaps_rollup`
  (2026-09-16, #171).
- **The box is not the repo, and repo silence is not evidence.** An audit of `docs/`, commits and
  `infra/` concluded the reboot-persistent firewall rule was unapplied; it had been live on the VPS
  for a week. Check the server before reporting a control missing, and write the result down -- the
  gap was the record, not the control (2026-09-16, #151).
