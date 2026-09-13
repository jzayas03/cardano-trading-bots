# docs/plans — historical record

**New multi-step work does NOT go here. It goes in `/specs/NNN-slug/plan.md`
at the repository root**, alongside that feature's `spec.md` and `tasks.md`. Full mapping:
[`../SPEC_DRIVEN_WORKFLOW.md`](../SPEC_DRIVEN_WORKFLOW.md).

This directory holds the date-named implementation plans written for M0–M6, before GitHub
Spec Kit was adopted on 2026-09-13. They are **not moved, not renamed, and not renumbered** —
they are cited from merged PRs and from the README. Correct one in place when it goes stale;
do not add to it.

The same reasoning applies here as in [`../specs/README.md`](../specs/README.md), which
explains why two directories ended up one path segment apart and what would go wrong if they
were merged. **The risk is split-brain** — half the future plans here, half in `/specs`, so
neither directory is complete. If you are about to add a dated file to this directory, stop
and read `../SPEC_DRIVEN_WORKFLOW.md`.

One difference worth noting: a Spec Kit plan is never a standalone document. It lives beside
the `spec.md` it implements and the `tasks.md` it generates, and `speckit-analyze` reads all
three together to report where they disagree. A plan written here on its own gets none of
that.
