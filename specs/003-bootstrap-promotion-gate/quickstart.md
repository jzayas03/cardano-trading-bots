# Quickstart: validating the bootstrap gate

Seven scenarios. Scenarios 1–5 run locally; 6 runs against the box read-only; 7 is a diff assertion.
None of them moves value, deploys anything, or writes to a database.

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
evidence — cite `test:pg` or cite nothing.

---

## 2. Determinism — the one that makes it a gate at all

```bash
npx vitest run packages/reports/test/bootstrap.test.ts
```

**Expected**: the same input evaluated twice yields byte-identical bounds, and a **separate process**
produces the same bounds again. A bootstrap that is only stable within one process is not
deterministic; the cross-process assertion is the one that matters.

Also expected: the source-text guard passes, asserting `Math.random` appears nowhere under
`packages/reports/src`. A determinism test alone would keep passing after someone reintroduced
ambient randomness elsewhere in the package.

---

## 3. The positive control — a strong edge clears below thirty

**Expected**: a series of ~12 consistently strongly-positive after-cost returns produces an interval
entirely above zero and a **passing** check, with the detail reporting the interval and the trip
count.

This is the property the whole feature exists for, and the reason "lower the constant" was rejected:
no value of a count can express it.

---

## 4. The negative control — thirty mediocre trips FAIL

**Expected**: 30 round trips whose returns average slightly positive but whose interval spans zero
produce a **failing** check.

**This is the scenario that proves the change is not a relaxation.** The identical input passes the
count check being replaced. If this test ever goes green-by-passing, the feature has become the thing
the constitution warns about.

A second negative control: a series dominated by one large winner among losses must also fail. That
is the case BCa's skew correction exists for.

---

## 5. Degenerate cases

**Expected**:

- 11 trips → fails on the minimum, **no interval in the detail**; 12 trips → proceeds to the interval.
  Both sides of the boundary are asserted.
- Zero variance, all trips identical at `r > 0` → bounds equal `r`, check passes, and **no `NaN`
  anywhere**. The jackknife variance is zero on this path and the acceleration term divides by it;
  a `NaN` bound would compare false against zero and fail closed for the wrong reason.
- A baseline strategy → refused as a non-candidate before any interval is computed.

---

## 6. The real run, read-only, against the box

A measurement week is in flight. This command **reads**; nothing is deployed and the live tree is not
touched — run it from a checkout of this branch.

```bash
npm run report -- --compare 147,149,146,153,151,6
```

**Predicted, and written down in [research.md](./research.md#r9) BEFORE running it** (FR-010):

- All six fail the evidence check **on the minimum branch** — fewer than 12 paired round trips.
- **No run reports an interval at all.**
- Runs 150 and 152 are baselines and fail earlier as non-candidates.
- Several runs carry additional blockers; the verdict lists every one, which is expected.
- **Nothing promotes.** Per Constitution Principle V that is the design working, not a disappointment.

**If any run reports an interval**, stop and investigate before believing the output: either the
pairing produced more round trips than its sell count suggested — which is possible, since one sell
can close several FIFO lots — or the minimum was not applied. Do not accept a contradicting result.

Record the observed output verbatim alongside the prediction.

---

## 7. The cost model is untouched

```bash
git diff origin/main -- packages/sim-executor/src/costs.ts packages/sim-executor/src/depth.ts \
  packages/reports/src/costFloor.ts .specify/memory/constitution.md
```

**Expected**: empty, except a **comment-only** hunk in `costFloor.ts` where `MIN_OBSERVATIONS` stops
citing the promotion gate as its reason and states its own (research R7). No value changes anywhere.

This is an assertion, not a promise: research R1 established that the interval compares against zero
because returns are already after-cost, so this feature has no reason to read the cost model at all.
If this diff shows a value change, the implementation went somewhere the plan did not.
