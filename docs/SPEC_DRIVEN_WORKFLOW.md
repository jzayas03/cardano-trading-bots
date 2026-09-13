# Spec-driven workflow

Adopted 2026-09-13. Tooling: [GitHub Spec Kit](https://github.com/github/spec-kit) v1.0.7,
scaffolded into `.specify/` with the Claude integration. Same process as the sibling
repositories; the constitution is this repo's own and shares nothing with them.

## Read this first: `specs/` and `docs/specs/` are two different things

This repo **already had** a spec-then-plan discipline before Spec Kit — date-named documents
under `docs/specs/` and `docs/plans/`, used through M0–M6, and pointed at by the README.
Spec Kit's scripts are hardcoded to a top-level `specs/NNN-slug/`. So there are now two
locations whose names differ by one path segment:

| Path | What it is |
|---|---|
| `docs/specs/YYYY-MM-DD-slug.md` | The existing convention. **Historical record. Not moved, not renamed.** |
| `docs/plans/YYYY-MM-DD-slug.md` | Same. |
| `specs/NNN-slug/{spec,plan,tasks}.md` | Spec Kit. **New multi-step work goes here.** |

**This is a real wart, stated rather than hidden.** Consolidate-forward was chosen for the
same reason as in the sibling repos: moving history does not make new work consistent, and
the old paths are cited from merged PRs and from the README. But `specs/` next to
`docs/specs/` is genuinely confusable, and it is worth a deliberate decision rather than
drift:

- **Keep both as described** (current state) — zero churn, one confusing pair of names.
- **Or retire Spec Kit's `specs/`** and keep writing `docs/specs/` + `docs/plans/`, using Spec
  Kit only for its constitution, `tasks.md` and `speckit-analyze`. That needs the scripts'
  `SPECS_DIR` pointed at `docs/specs`, which diverges from upstream and will be overwritten by
  the next `specify init`.

Until that is decided, the table above is the rule.

Both old trees carry a `README.md` signpost pointing here, so the warning is read at the
moment someone is about to add a file to the wrong one: [`docs/specs/README.md`](specs/README.md)
and [`docs/plans/README.md`](plans/README.md). **The risk being prevented is split-brain** —
half the future specs in one tree, half in the other, so neither is complete. That is worse
than either location alone.

## What Spec Kit actually adds here

The honest accounting, because this repo already had specs and plans:

- **A constitution.** The largest gain by far. There was no `CLAUDE.md` and no `AGENTS.md`, so
  an agent session started with **zero** project rules — free to run `npm test` and call it a
  gate, compare a USD return against an ADA cost floor, or trust a dust pool's quoted spread.
  `.specify/memory/constitution.md` is now the first thing every Spec Kit skill reads.
- **`tasks.md`.** The repo had specs and plans but no dependency-ordered task breakdown.
- **`speckit-analyze`.** Cross-artifact consistency across spec/plan/tasks. Nothing did this.
- **Collision-free numbering.** Weakest of the four here — `YYYY-MM-DD-slug` already does not
  collide in practice (two specs share 2026-09-08 with different slugs).

## The lifecycle

Skills are invoked by name (the Claude integration uses `-`, so `speckit-specify`).

| Step | Skill | Produces |
|---|---|---|
| 1 | `speckit-constitution` | Already written — amend, do not regenerate |
| 2 | `speckit-specify` | `specs/NNN-slug/spec.md` |
| 3 | `speckit-clarify` *(optional)* | Questions folded into `spec.md`, **before** plan |
| 4 | `speckit-plan` | `specs/NNN-slug/plan.md` |
| 5 | `speckit-tasks` | `specs/NNN-slug/tasks.md` |
| 6 | `speckit-analyze` *(optional)* | Consistency report, after tasks, before implement |
| 7 | `speckit-implement` | Executes `tasks.md` — bounded by the approval gate |
| 8 | `speckit-converge` | Appends what is still unbuilt |

`create-new-feature.sh` computes the next free number and creates **no git branches**.

## Two constraints specific to this repo

**The gate is `npm run test:pg`, not `npm test`.** Plain `npm test` runs `vitest run` and
**skips every Postgres test** — it is green on a persistence layer that is entirely broken.
A skill that reports "tests pass" after `npm test` has verified the wrong thing. Constitution
Principle IV governs.

**A spec may not quietly change the cost model.** `speckit-specify` will happily write a
plausible fee or threshold into a requirement. The 216 bps round-trip floor is measured, and
lowering it overstates every strategy's edge in the direction that pushes a losing strategy
through the promotion gate. Principle I governs: measure the submission path, then the model —
and it is a founder decision either way.

## Upgrading Spec Kit

`.specify/` is tracked; the scaffolded version is in `.specify/integration.json`. Re-running
init refreshes templates and scripts and **overwrites local edits to them** — including any
`SPECS_DIR` change from the decision above. `.specify/memory/constitution.md` is content, not
scaffolding: never let an upgrade regenerate it.

```bash
specify init --here --force --integration claude
```
