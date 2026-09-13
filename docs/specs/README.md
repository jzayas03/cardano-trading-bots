# docs/specs — historical record

**New multi-step work does NOT go here. It goes in `/specs/NNN-slug/spec.md`
at the repository root.** Full mapping: [`../SPEC_DRIVEN_WORKFLOW.md`](../SPEC_DRIVEN_WORKFLOW.md).

This directory holds the date-named design documents written for M0–M6, before GitHub Spec
Kit was adopted on 2026-09-13. They are **not moved, not renamed, and not renumbered** — they
are cited from merged PRs and from the README, and moving history does not make new work
consistent. Correct one in place when it goes stale; do not add to it.

## Why there are two directories one path segment apart

Spec Kit hardcodes `SPECS_DIR="$REPO_ROOT/specs"` (`.specify/scripts/bash/create-new-feature.sh`).
Pointing it at `docs/specs` would mean editing a vendored script that
`specify init --force` silently overwrites on the next upgrade — after which new features would
quietly start landing in `/specs` again with nothing failing. That failure mode is worse than
the confusing pair of names, so the names stayed.

**The risk this file exists to prevent is split-brain**: half the future specs here, half in
`/specs`, so neither directory is complete. If you are about to add a dated file to this
directory, that is the mistake — stop and read `../SPEC_DRIVEN_WORKFLOW.md`.

## If this keeps being confusing

That is a signal, not a nuisance. If you find yourself hesitating about where a document goes
two or three features from now, collapse back to using Spec Kit for its constitution only and
keep writing here — a cheap retreat (stop invoking `speckit-specify`, remove an empty
`/specs`), not a migration. `../SPEC_DRIVEN_WORKFLOW.md` records that option and why it was
not the starting choice.
