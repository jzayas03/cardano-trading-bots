# Feature Specification: Bootstrap the promotion gate's round-trip evidence

**Feature Branch**: `feat/bootstrap-promotion-gate`

**Created**: 2026-09-17

**Status**: Draft

**Input**: Founder decision 2026-09-17 — lower the round-trip bar, and lower it by replacing the
count with a bootstrap over actual round-trip returns rather than by changing the constant.

## Why this exists

The gate decides its round-trip check by comparing a count of completed round trips against a fixed
constant of thirty. That is a **bare count**, and there is no significance test anywhere in the
gate. A count cannot express the thing a promotion decision needs to know: whether the returns
observed are distinguishable from luck.

The constant's own derivation is recorded, beside it, as **measured unsound**. Across three
corpora of 83, 162 and 148 completed round trips, excess kurtosis came out 8.38, 13.06 and 2.54 —
every one strongly positive, so the returns are decisively not normal, and kurtosis is dimensionless
so that conclusion survives those corpora being USD-priced. The ratio of measured to normal-implied
σ was 1.02, 1.29 and 0.63: it runs in **both** directions and varies by more than 2x, so there is no
multiplier to apply. The record states the remedy this feature implements:

> the parametric route to a sample size is the wrong tool here, not a mis-tuned one, and the fix is
> a bootstrap over actual round-trip returns rather than a new constant.

and the condition for acting on it:

> Revisit when there are ADA-denominated round trips to bootstrap against.

**This reverses a decision taken the day before.** Two operational documents record "the bar stays at
thirty, the lever is more instruments" (#167). Both must be updated by this feature rather than left
contradicting the gate.

**This is not a relaxation, and the spec must not be read as one.** For a strategy with thirty
mediocre round trips the new gate is **stricter** — thirty trips with no distinguishable edge passes
the old check and fails the new one. What changes is that the bar becomes a function of the evidence
rather than a constant: strong evidence can clear on fewer trips, weak evidence cannot clear on
more. Constitution Principle V ("the promotion gate exists in order not to be gamed") is served by
that, not weakened by it, and the constitution's stop-and-ask for "changing the promotion gate's
thresholds or sample size" was satisfied by an explicit founder decision on 2026-09-17.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A large, obvious edge is promotable without waiting for thirty trips (Priority: P1)

The founder runs a strategy that produces a small number of round trips, each strongly and
consistently positive after costs. Today the gate refuses it purely because the count is below
thirty, and would keep refusing for roughly two years at the observed fill rate. The founder wants
the gate to recognise that the evidence is already unambiguous, while still refusing a strategy
whose returns merely happen to average positive.

**Why this priority**: It is the entire motivation for the feature. The asymmetry — strong evidence
clears early, weak evidence never clears — is the property a count cannot express at any value.

**Independent Test**: Construct two round-trip series, one with a large consistent positive return
and few trips, one with a marginal noisy return and many trips. The first must produce a passing
evidence check and the second must not, with no change to any other check.

**Acceptance Scenarios**:

1. **Given** a strategy with 12 round trips whose after-cost returns are consistently and strongly
   positive, **When** the gate evaluates it, **Then** the evidence check passes and the detail says
   what interval was computed and over how many trips.
2. **Given** a strategy with 30 round trips whose after-cost returns average slightly positive but
   whose interval includes zero, **When** the gate evaluates it, **Then** the evidence check FAILS —
   the same input passes the count check it replaces.
3. **Given** a strategy whose returns are dominated by one large winner among losses, **When** the
   gate evaluates it, **Then** the evidence check fails, because a resampled interval on a fat-tailed
   series with one outlier does not exclude zero.

---

### User Story 2 - The gate refuses on thin evidence, and says so legibly (Priority: P2)

Only seventeen ADA-denominated paper round trips exist in the entire project. The founder needs the
gate to refuse every one of today's runs for a reason that is readable, and to distinguish "not
enough trips to say anything" from "enough trips, and the answer is no".

**Why this priority**: It is the near-term reality and the correctness condition. A gate that
produced a promotion from today's data would be wrong.

**Independent Test**: Evaluate the real runs on the box (147, 149, 146, 153, 151, 6) and confirm each
fails, and that the failure detail distinguishes insufficient evidence from insufficient edge.

**Acceptance Scenarios**:

1. **Given** a run with fewer round trips than the pre-registered minimum, **When** the gate
   evaluates it, **Then** the check fails with a detail naming the count and the minimum, and does
   NOT report an interval — an interval computed below the minimum would be a number that looks like
   evidence.
2. **Given** a run with enough trips but an interval spanning zero, **When** the gate evaluates it,
   **Then** the check fails with a detail reporting the interval.
3. **Given** any failing run, **When** the verdict is produced, **Then** every other check is still
   reported and every blocker is listed, not merely the first.

---

### User Story 3 - The same evidence always produces the same verdict (Priority: P3)

A bootstrap resamples at random. The founder needs a verdict that does not change between two
evaluations of identical data, and a record of the procedure that produced it.

**Why this priority**: Independently testable and non-negotiable for correctness, but it constrains
how US1 and US2 are built rather than delivering separate value.

**Independent Test**: Evaluate the same input twice in one process and in two processes; the verdict,
the interval bounds and the reported detail must be byte-identical.

**Acceptance Scenarios**:

1. **Given** identical round-trip input, **When** the gate is evaluated repeatedly, **Then** the
   verdict and the interval bounds are identical every time.
2. **Given** a verdict, **When** the founder reads it, **Then** the confidence level, the resample
   count and the minimum trip count are discoverable from the recorded output.

---

### Edge Cases

- **Fewer trips than the minimum**, including zero and one: refuse, and report no interval.
- **Exactly the minimum**: the boundary must be specified and tested on both sides.
- **Zero variance** — every round trip returns identically: a resampled interval is degenerate
  (both bounds equal). If that value is above zero the check may pass; the behaviour must be
  deliberate and tested, not incidental.
- **One dominant outlier** among otherwise losing trips: must not pass (US1 scenario 3).
- **A baseline strategy**: baselines are not promotion candidates and that existing refusal takes
  precedence over any evidence check.
- **A run predating this feature** with no recorded orders: refuse, as absence of evidence.
- **The per-route cost floor from specs/002 is insufficient or excluded for this route**: does
  not block the evidence check, because round-trip returns are already net of realised costs — see
  the double-counting note under Assumptions.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The gate MUST decide the round-trip check from a resampled confidence interval over
  the strategy's own completed round-trip returns, not from a count compared to a constant.
- **FR-002**: The check MUST pass only when the interval lies entirely above zero.
- **FR-003**: The interval MUST be computed on **after-cost** round-trip returns. The existing
  pairing already subtracts both legs' batcher and network fees and prices the fill through the pool,
  so zero is the correct comparand. The check MUST NOT additionally subtract a cost floor; doing so
  would charge costs twice, which is the specific error specs/002 exists to prevent.
- **FR-004**: An absolute minimum number of round trips MUST be enforced, below which the check fails
  and NO interval is reported. The value MUST be pre-registered and MUST carry a written
  justification; it MUST NOT be chosen as a round number.
- **FR-005**: The procedure MUST be deterministic. Two evaluations of identical input MUST produce
  identical verdicts and identical interval bounds, in the same process and across processes.
- **FR-006**: The confidence level, the resample count and the minimum trip count MUST be fixed
  constants, recorded in the verdict's output, and fixed BEFORE the procedure is evaluated against
  real runs.
- **FR-007**: The check's detail string MUST distinguish "fewer trips than the minimum" from "enough
  trips, interval includes zero", and MUST report the interval in the latter case.
- **FR-008**: The gate MUST continue to report EVERY check, passing or failing, and to list
  EVERY blocker rather than the first. This property MUST NOT regress.
- **FR-009**: The existing refusal of baseline strategies as promotion candidates MUST take
  precedence over the evidence check.
- **FR-010**: The feature MUST state, in advance of running it, what it predicts for runs 147, 149,
  146, 153, 151 and 6, and MUST record the observed result against that prediction. A result that
  contradicts the prediction MUST be investigated, not accepted.
- **FR-011**: The feature MUST NOT change any venue cost value, the default cost floor, the default
  maximum price impact, or the constitution's stated 216 bps. Any proposal to do so is a
  stop-and-ask, never an edit.
- **FR-012**: Every operational document that currently asserts the bar stays at thirty MUST be
  updated, so that no document contradicts the gate.
- **FR-013**: The disposition of the existing thirty-round-trip constant MUST be stated explicitly —
  retained as the absolute minimum, replaced, or kept for another purpose — because the cost-floor
  report keys its own sufficiency bar to the same constant "for internal consistency" and therefore
  moves with it.
- **FR-014**: No new quantile implementation. The repository already contains four, one of them
  private to the round-trip module; the interval MUST reuse an existing one.

### Key Entities

- **Round-trip return**: one completed buy-to-sell pair, already paired FIFO and already net of both
  legs' fees, expressed in basis points. The unit of evidence.
- **Evidence interval**: a resampled confidence interval over a run's round-trip returns, with its
  confidence level, resample count and trip count.
- **Promotion check**: an existing auditable record of one gate condition — id, pass/fail, and a
  human-readable detail.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A strategy with a large, consistent after-cost edge reaches a passing evidence check on
  fewer than thirty round trips; a strategy with a marginal edge does not reach one at thirty.
- **SC-002**: Every run currently in the database fails the gate, and the failure reason for each is
  legible and correct.
- **SC-003**: Repeated evaluation of identical input yields identical verdicts, demonstrated by test
  rather than asserted.
- **SC-004**: The confidence level, resample count and minimum trip count are recoverable from the
  gate's own output without reading the source.
- **SC-005**: No figure in the cost model changes, demonstrated by a diff over the cost-model files.
- **SC-006**: No document in the repository still claims the round-trip bar is a fixed thirty.

## Assumptions

- **The interval is on the strategy's own returns against zero, not against the baselines.** The gate
  already has a separate `beats-baselines` check. Testing the difference against baselines here would
  either duplicate or contradict it. Adding significance to `beats-baselines` is **out of scope** and
  left as a later decision.
- **Zero is the correct comparand** because the paired returns are already after-cost (FR-003). This
  is an assumption about the existing pairing's semantics and must be verified against the code
  during planning, not taken from this sentence.
- **95% confidence**, matching the two-sided 1.96 the superseded derivation used, so the change is to
  the method and not simultaneously to the strictness.
- **A percentile bootstrap is the starting procedure.** With excess kurtosis of 8–13 a percentile
  interval at small n is itself unreliable, and the spec is honest that this replaces an unsound
  parametric assumption with a better but still imperfect one. Whether a bias-corrected variant is
  warranted is a planning question.
- **The minimum trip count is pre-registered during planning**, before the procedure is run against
  real data, and its justification is recorded with it.
- Only seventeen ADA-denominated paper round trips exist (runs 147, 149, 146, 153, 151, 6 — 8, 4, 2,
  1, 1, 1 — measured on the box 2026-09-17). The 739 SNEK filled sells are overwhelmingly backtests
  over external USD-denominated candles, which is the corpus already recorded as one σ cannot be
  taken from. **Nothing promoting is the expected and correct near-term outcome.**
- The reporting layer remains pure; the interval belongs on the pure side, and a purity guard already
  enforces it.
- No funds, no keys, no seed phrase, no preprod, no mainnet. Nothing in this feature moves value.
- `npm run test:pg`, `npm run lint` and `npm run lint:sh` are the gates. `npm test` and `npx vitest`
  skip the Postgres suite and are not evidence.
