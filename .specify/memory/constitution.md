# cardano-trading-bots Constitution

> **This repository has no `CLAUDE.md`.** For the other projects this file restates one;
> here there was nothing to restate, so it was derived from the README, from the reasoning
> already written into test headers under `packages/*/test/`, and from operating history.
> That makes it the only rules file an agent session reads — and it has not been ratified by
> anyone. Treat a rule here as a claim to check against the code, not as settled law, and
> correct it in place when the code disagrees.
>
> **This repository is public.** Nothing operational belongs in this file — no hosts, no
> credentials, no infrastructure state. Methodology only.

Paper-trading foundation for Cardano DEX bots. **No real funds move in this repo.** The
failure mode that matters is not a crash; it is a number that looks right, survives review,
and pushes a losing strategy through the promotion gate.

## Core Principles

### I. The Cost Model Is Measured, Never Asserted (NON-NEGOTIABLE)

The round-trip cost floor is **216 bps**, and it is measured. It is not a parameter to be
tuned until a strategy looks profitable.

`packages/sim-executor/test/dexterWritesTheBatcherFee.guard.test.ts` records why this is a
principle and not a constant: an LLM asserted, fluently and as policy, that Minswap removed
batcher fees in May 2025 and advised lowering the cost table. Acting on it would have
modelled 176 bps while the chain still charged 216 — **overstating every strategy's edge by
40 bps, in exactly the direction that pushes a losing strategy through the promotion gate.**
Dexter 5.4.10 hardcodes `batcherFee: 2000000n` into the MinswapV2 datum; what a vendor's
changelog says is not what your library submits.

So: **the submission path is the authority, not the documentation.** If you believe a fee
changed, override the datum parameter and measure what is actually paid *before* touching
the model. Lowering the cost model is a founder decision, never an implementation detail.

### II. Units Are Part Of The Number

External candles arrive in **USD**; internal accounting is in **ADA**. GeckoTerminal defaults
to USD, and `packages/cli/src/commands/backfill.ts` takes `--currency ada|usd` defaulting to
`ada` for exactly this reason. This has already gone wrong once, at scale: three months of
USD rows landed in `candles_external`, and a USD return was then read against an ADA cost
floor — a comparison that is meaningless and looks entirely normal.

A price without its currency is not a price. Carry the unit through every function signature,
every column, and every report that a human will read.

### III. A Quoted Price Is Not A Market

Thin pools quote arbitrage that does not exist — spreads in the thousands of bps that no one
can trade. Corroborate a price across venues that are actually deep before believing it, and
filter candidates by depth (`packages/sim-executor/src/depth.ts`).

**Prove a filter in both directions.** `depth.test.ts` states it plainly: a filter that
removed everything would satisfy "excludes the dust" on its own. What makes it useful is that
the survivors agree inside the round-trip cost floor while the raw set does not. A threshold
is justified by measurement or it is a guess — 34 bps in that file "is not chosen here, it is
the price-impact half of the measured round-trip floor".

### IV. `npm test` Is Not The Gate

```bash
npm run test:pg     # RUN_PG_TESTS=1 — THE gate
npm run lint        # eslint + typecheck
```

**`npm test` runs `vitest run` and SKIPS every Postgres test.** It is green on a persistence
layer that is entirely broken. Only `test:pg` sets `RUN_PG_TESTS=1`. `test:live`
(`RUN_LIVE_TESTS=1`) is a third suite that hits a real source and is opt-in by design.

Nothing is "implemented" until `test:pg` and `lint` have both been run and repaired until
green, and failures are reported with their output. Citing `npm test` as evidence is citing
the wrong suite.

### V. The Promotion Gate Exists In Order Not To Be Gamed

A strategy is promoted only by clearing the gate on its own evidence. **A week that promotes
nothing is the design working, not a disappointment** — and it is the moment when quietly
relaxing a threshold, a cost, or a sample size is most tempting and most damaging.

**Never project a rate from an average that mixes two regimes.** A daily shape of many cheap
ticks plus one expensive sweep has an average that describes neither: multiplying the sweep
hour's per-tick rate across every tick of the day charges a once-daily job hundreds of times
and turns a healthy quota into a false alarm. State the denominator with every rate.

## Additional Constraints

**Stack.** TypeScript, Node (`nvm use`), vitest, eslint, Postgres via `docker compose up -d
postgres`, `npm run migrate`. Monorepo under `packages/` — `collector`, `sim-executor`,
`cli`, dashboard. The dashboard is **read-only and localhost-only**.

**No real funds.** This repo is a paper-trading foundation. Any change that would move real
value is out of scope for an agent and is a founder decision made deliberately, elsewhere.

**Merged is not deployed.** Merging to `main` here ships nothing by itself. A deployment is a
separate, deliberate act, and holding the deployed revision behind `main` during a measurement
window is a normal and intentional state — not drift to be "fixed".

**Stop and ask the founder first** before: lowering or re-parameterising the cost model;
promoting a strategy; changing the promotion gate's thresholds or sample size; anything that
moves real funds; or deploying while a measurement run is in flight.

## Development Workflow

**Plan before code, and the plan is approved by the founder** (`~/.claude/CLAUDE.md`): every
task opens with a plan of ≤10 lines saying what changes, what is left alone and why, the one
decision only the founder can make, and how it is verified — then waits for an OK. Reading
and exploring need no plan; writing does.

**Where artifacts live.** New multi-step work uses `specs/NNN-slug/`
(`spec.md` → `plan.md` → `tasks.md`). The existing `docs/specs/` and `docs/plans/` trees are
historical record and are not moved or renamed. **That overlap is real and is documented in
`docs/SPEC_DRIVEN_WORKFLOW.md` — read it before creating either.** A one-liner keeps just the
≤10-line plan.

**`speckit-implement` is bounded by that approval gate.** It may run only against a `tasks.md`
the founder has approved, and must stop at the stop-and-ask list above. An approved `tasks.md`
*is* an approved plan; anything beyond it is not.

**Never commit directly to `main`** — PR branch, always.

## Governance

This constitution is currently the only rules file in the repository. If a `CLAUDE.md` is ever
added, **that becomes authoritative and this file restates it**, as in the sibling projects.

Spec Kit skills MUST check plans and tasks against this file and surface violations rather
than working around them. A principle that cannot be satisfied is a reason to stop and ask,
not to proceed with an exception. In particular: no skill may lower the cost model, relax the
promotion gate, or cite `npm test` as the test gate.

**Version**: 1.0.0 | **Ratified**: 2026-09-13 | **Last Amended**: 2026-09-13
