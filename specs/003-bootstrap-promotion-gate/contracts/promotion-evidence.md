# Contract: the evidence interval and the check that consumes it

`@ctb/reports` is a library, so its contract is its exported surface. Everything below is pure: no
I/O, no clock, no ambient randomness.

---

## `bcaMeanInterval(returnsBps, options?) -> EvidenceInterval`

A BCa bootstrap confidence interval on the **mean** of the supplied values.

**Guarantees**

1. **Deterministic.** Identical input yields byte-identical bounds, in the same process and across
   processes. The only randomness is a PRNG seeded from a fixed recorded constant.
2. **Finite.** Both bounds are finite numbers for every input of length ≥ 2, including the
   zero-variance case, which returns `[mean, mean]`.
3. **Ordered.** `lowerBps <= upperBps`.
4. **Self-describing.** The returned value carries `confidencePct`, `resamples` and `trips`, so a
   caller never has to assume them.
5. **Pure.** No `Math.random`, no `node:crypto`, no clock, no I/O. Enforced by a source-text guard,
   not by convention.

**Pre-registered defaults** (research R5): 95% two-sided, 10,000 resamples, one fixed seed.
`options` exists for tests to pin smaller resample counts; **the gate never passes options.**

**Refuses** rather than guessing: fewer than 2 values has no variance to resample and throws. The
gate never reaches that path because its own minimum is 12.

---

## `MIN_TRIPS_FOR_INTERVAL`

The pre-registered minimum, **12** (research R5). Exported so the check's detail string and the tests
read the same constant, and so a reader can find it without the source.

**Not** coupled to `costFloor.ts`'s `MIN_OBSERVATIONS`, which keeps 30 for its own reason (R7).
Coupling them would drag the cost-floor sufficiency bar down with this change, which is a cost-model
change and a founder decision.

---

## `promotionVerdict(input) -> PromotionVerdict` (existing, behaviour changed)

**What changes**: the `round-trips` check no longer compares a count to a constant.

**What must NOT change**, and is asserted by existing tests that must keep passing:

- Every check is reported, passing or failing. A gate that only speaks when it fails cannot be
  audited.
- Every blocker is listed, not merely the first. Fixing one must not reveal another.
- A baseline strategy is never a promotion candidate, and that refusal short-circuits first.

**New input**: `roundTripReturnsBps: readonly number[]` — paired after-cost returns, never a count of
sell orders (research R8).

**Check outcomes**, exactly three and no default-bearing fourth:

| Condition | `passed` | `detail` |
|---|---|---|
| strategy is a baseline | false | existing wording, unchanged |
| `trips < 12` | false | names the count and the minimum; **no interval** |
| `trips >= 12` | `lowerBps > 0` | reports the interval either way |

---

## Compatibility

**Breaking for callers**: `PromotionInput` gains a required field. There is exactly one non-test
caller — `compare.ts:99` — and it already has `orders` in scope, so it pairs the trips locally. No
new plumbing, no new command, no CLI surface change.

**The reported output changes shape in one place**: the blocker sentence printed under
`report --compare` now describes an interval rather than a count. That is the intended, visible
effect and is what FR-010's recorded run captures.
