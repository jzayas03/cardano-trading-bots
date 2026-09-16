---
name: memory-layers
description: Five-layer agent memory procedure (working, episodic, semantic, procedural, pruning). Use at the start of every task to decide what to recall, at the end to write back, and whenever a memory file or the memory index is edited. Applies to every task in this repo.
---

# memory-layers

Memory data lives in the harness per-project directory
(`~/.claude/projects/<repo-path-slug>/memory/`), never in the repo. No memory file may
contain PHI/PII, a secret, a raw payload, or a relative date. Adopted 2026-09-16, per repo.

## Layers → files

| Layer | Lives in | Write when |
| --- | --- | --- |
| 1 Working | context window; offload with `/context-save`, resume with `/context-restore` | context grows or before compaction |
| 2 Episodic | `episodes.md`, one line: `[YYYY-MM-DD] event \| outcome \| detail` | every session end; any failed run, deploy, or gate |
| 3 Semantic | `user_*.md`, `project_*.md`, `reference_*.md` | a durable fact, preference, or relationship is learned or changes |
| 4 Procedural | `feedback_*.md` (method that worked, or a correction) and repo skills | a method proved out or a correction was given |
| 5 Pruning | applied to all of the above | every write-back |

## Before a task: retrieve (budget ≈ 1,800 tokens)

1. Read `MEMORY.md` (the index) only. Open at most 3 memory files whose hook matches the task.
2. Grep `episodes.md` for the subsystem or command name; read only the matching lines.
3. Never load raw transcripts or full history. `/context-restore` is a handoff, not a log.
4. Say "Recalling from <layer>" only when a recalled item changed the plan or the answer.

## After a task: write back

1. **Episodic:** append one line to `episodes.md`. Outcome vocabulary: `DONE` / `FAILED` /
   `PARTIAL` / `BLOCKED`. Detail ≤ 20 words. Name the commit, PR, or command, never a patient
   or a credential.
2. **Semantic:** a new durable fact → new or updated `project_*` / `user_*` file, dated
   absolutely (`2026-09-16`, not "today"). One fact per file.
3. **Procedural:** a method that worked or a correction → `feedback_*` file with **Why** and
   **How to apply**. If it is reusable across tasks, propose a repo skill instead of a memory.
4. **Pruning (every write-back):**
   - Contradiction → the newer dated fact wins; delete the older one or mark it superseded in one line.
   - `MEMORY.md`: one line per file, ≤ 25 words per line, ≤ 60 lines total. No content in the index.
   - `episodes.md` ≤ 40 lines. On overflow distill the oldest lines into a semantic or procedural file, or delete them.
   - Delete `.bak` files, archive copies, and any memory the code, `git log`, or CLAUDE.md already records.
   - Unreferenced for 90 days, or low confidence → delete.
5. Add an index line in `MEMORY.md` for every new file. Close the task with the usual
   `CLAUDE.md rule: yes/no` line.

## Self-check before ending a session

- Does every new memory file have an index line, and is the index still ≤ 60 lines?
- Does any memory line contain PHI, a secret, or a relative date?
- Would a fresh session reading only the index and `episodes.md` know what happened and what to avoid?
