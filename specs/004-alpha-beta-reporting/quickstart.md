# Quickstart: validating the exposure-adjusted measurement

Eight scenarios. 1-6 run locally; 7 runs against the box read-only; 8 is a diff assertion. None moves
value, deploys anything, or writes to a database.

## Prerequisites

```bash
nvm use
docker compose up -d postgres     # test:pg needs it
```

---

## 1. The gates

```bash
npm run lint && npm run lint:sh && npm run test:pg
```

**Expected**: all three green. `npm test` and `npx vitest` skip every Postgres test and are **not**
evidence.

---

## 2. THE KNOWN-ANSWER CONTROL — a token holder must show beta ≈ 1

**Expected**: a synthetic run whose equity tracks the token one-for-one reports **beta within a
stated tolerance of 1** and **alpha within a stated tolerance of 0** after the cash charge.

This is the scenario that says the estimator is right rather than merely running. A measurement that
cannot recover a beta of one from a pure holder is broken, and every other number it produces is
meaningless. If this fails, stop — do not tune tolerances to make it pass.

---

## 3. The collapse, and the zero-inflation it exists for

**Expected**:

- A series with prices repeated in runs of two to five collapses to one observation per **price
  change**, and `sum(ticksSpanned)` equals the raw count — nothing dropped, repetition merged.
- **No collapsed interval has a zero benchmark return.** One that does means the collapse did not run.
- Strategy and benchmark returns are measured over the **same spans**. Measuring one per tick and the
  other per price change is the most likely way to get this silently wrong, so it has its own
  assertion.
- Regressing the uncollapsed series produces a **smaller beta and a larger alpha** than the collapsed
  one. That is attenuation, and demonstrating it is what justifies the whole design (research R1).

---

## 4. Idle cash does not earn alpha

**Expected**: a run that holds only cash for the whole window reports alpha ≈ 0, not a positive alpha
equal to the token's decline. Remove the cash charge and this test must fail — that is the check that
FR-005 is doing something rather than being decorative.

The assumed rate appears in the output (FR-006).

---

## 5. Refusals, each with its own reason

**Expected**, one outcome per input and no fallthrough:

| Input | Output |
|---|---|
| a backtest (no equity observations) | `not-applicable` |
| a run still in progress | `window-open` |
| a flat benchmark across the whole window | `benchmark-did-not-move` |
| a run that never held a position | `no-position-taken`, beta 0, labelled **definitional** |
| fewer than 2 collapsed intervals | `too-few-observations` |

No `NaN` on any path, including a single collapsed interval and a zero-variance benchmark.

---

## 6. Determinism, and the two stabilities kept apart

**Expected**: identical observations yield byte-identical output, including across processes — pin
bounds as literals produced by a different process, as specs/003 did.

Also expected: **seed stability and split-window beta are labelled distinctly** in the output. They
answer different questions — "is this interval a numerical artefact?" versus "did the exposure
drift?" — and conflating them would let a stable-seed reading be quoted as a stable-exposure claim.

---

## 7. The real run, read-only, against the box

A measurement week is in flight and the box runs a sha 35 commits behind. **Nothing is deployed and
the live tree is not touched**: export the equity rows for runs 150-153 with one read-only query and
run the pure functions locally, exactly as specs/003 did. That is faithful because the reports layer
is pure.

**Predicted, and written into [research.md](./research.md#r9) BEFORE running it**:

1. The interval on alpha is **far too wide to exclude zero** for all four runs. The spec names this a
   legitimate outcome.
2. `n_eff` is materially **below** the ~45 collapsed observations.
3. **Runs 150 and 152 show beta near one** — they are essentially always long. **This is the
   load-bearing prediction**: it is the closest thing to a known-answer test on real data, and if
   either fails it, the estimator is wrong and not the strategy.
4. Runs 151 and 153 show beta well below one, having spent much of the window in cash.
5. Split-window betas overlap widely, because the window is short. Honest, not a finding.

**Record the observed output verbatim against the prediction. A contradiction is investigated, not
accepted.**

---

## 8. Nothing that decides anything has changed

```bash
git diff origin/main -- packages/reports/src/promotion.ts packages/sim-executor/src/costs.ts \
  packages/sim-executor/src/depth.ts packages/reports/src/costFloor.ts .specify/memory/constitution.md
```

**Expected**: empty. `promotion.ts` is untouched — the only promotion-related change in this feature
is a **test** asserting the verdict's status, checks and blockers are identical for every existing
case (FR-012).

This is the founder's condition for the feature existing, so it is asserted by diff and by test
rather than promised.
