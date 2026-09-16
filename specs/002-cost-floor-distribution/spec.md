# Feature Specification: Cost Floor Distribution

**Feature Branch**: `feat/cost-floor-distribution`

**Created**: 2026-09-16

**Status**: Draft

**Input**: User description: replace the single-observation 2.16% round-trip cost floor with a measured distribution per route and order size, so the number that gates M6 is traceable to observations with counts and dates.

## Why this exists

Two documents in this repository disagree about what the cost floor is, and both are load-bearing.

The constitution states it as settled: "The round-trip cost floor is **216 bps**, and it is
measured." The M6 execution spec, which defines the gate that number is used to judge, says the
opposite in §2.1: the figure is **one paper fill** (run 139, 990 ADA into NIGHT on MinswapV2), it
"should become a measured DISTRIBUTION per route and order size, taken from contemporaneous quotes,
before any figure here is treated as fixed", and it is the **optimistic** reading.

Both can be repaired by the same work, and the repair runs in the direction the constitution already
demands. 216 bps is not wrong; it is **n=1**. This feature does not dispute the number. It replaces
an anecdote with a distribution and makes every figure downstream of it say how it knows.

It matters now because M6 gate 1 — "a strategy has cleared the cost floor on a full clean week" — is
currently judged against that anecdote, and the first honest answer to "did anything clear it?" is
"clear what, exactly, and how sure are we?"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The founder sees a spread, not a headline (Priority: P1)

The founder is deciding whether any strategy can clear the real cost of trading. Today the answer
rests on one number from one fill. They ask what a round trip actually costs on the routes the bot
would use, and get a distribution per route and order size, each figure carrying how many
observations it came from and over what dates — so that "2.16%" is either confirmed with evidence,
or revealed as one draw from a wide spread.

**Why this priority**: every other decision in M6 is downstream of this number, and it is the number
the constitution names as the one most damaging to get wrong. If the distribution is wide or worse
than 216 bps, the go/no-go on building execution changes.

**Independent Test**: run the report against the collected data and read it. It delivers value with
no other part of this feature built: a founder who sees "n=1, one route, one day" learns the most
important thing here even if nothing else ships.

**Acceptance Scenarios**:

1. **Given** collected pool snapshots covering several routes, **When** the founder asks for the cost
   floor, **Then** the output shows, per route and order-size bucket, a distribution with at minimum
   a median and an upper percentile, the observation count, and the first and last observation dates.
2. **Given** a route with fewer observations than the sufficiency threshold, **When** the report
   runs, **Then** that route is listed under an explicit "not enough observations to say anything"
   heading and **no** percentile is printed for it — an insufficient route must not render as a thin
   distribution.
3. **Given** the report has run, **When** the founder compares it to the 216 bps figure, **Then** the
   output states plainly how many observations 216 bps itself rests on, so the comparison is between
   like and like.

---

### User Story 2 - No figure claims to be measured when it is assumed (Priority: P1)

The founder reads a per-route cost and can tell, without cross-referencing another file, whether
every component of it was measured on chain or partly assumed. A route whose venue fee is still
`assumed` is never presented as a measured cost.

**Why this priority**: shares P1 with Story 1 because a measured-looking number with an assumed
component is worse than no number. Four of nine venues are still `assumed`, and **Splash is known to
err cheap** — it carries two fee fields and its take varies by pool, while the cost table is keyed by
venue. An optimistic cost estimate inflates every strategy's apparent edge, which is precisely the
direction the constitution says pushes a losing strategy through the gate.

**Independent Test**: run the report on a route whose venue is `assumed` and confirm the output
labels it, and that the summary does not fold it into a measured aggregate.

**Acceptance Scenarios**:

1. **Given** a route on a venue whose cost basis is `assumed`, **When** the report runs, **Then**
   that route's figure is labelled with its weakest component basis and is excluded from any
   aggregate presented as measured.
2. **Given** a route on a venue known to err cheap, **When** the report runs, **Then** the direction
   of the error is stated alongside the figure, not only its existence.
3. **Given** any reported figure, **When** a reader asks where it came from, **Then** the report
   names the observations behind it well enough to re-derive it.

---

### User Story 3 - The floor is shaped for the control that will consume it (Priority: P2)

The distribution is expressed so that the M6 §7 "minimum edge" control — refuse any round trip whose
expected move does not clear the floor — can later read a per-route, per-size figure rather than a
global constant.

**Why this priority**: P2 because the report delivers the decision value on its own. This story is
what stops the result being a document that has to be re-derived by hand when execution is built.

**Independent Test**: a consumer can request the floor for a given route and order size and receive
either a figure with its basis and confidence, or an explicit refusal when observations are
insufficient. Testable with no execution code in existence.

**Acceptance Scenarios**:

1. **Given** a route and order size with sufficient observations, **When** a caller asks for the
   floor, **Then** it receives the figure, its basis, and its observation count.
2. **Given** a route with insufficient observations, **When** a caller asks for the floor, **Then**
   it receives an explicit "insufficient" answer and **never** a silent fallback to a global default
   — fail closed, per M6 §7.

---

### Edge Cases

- **A route with exactly one observation.** This is today's state for the floor itself. It must
  report as insufficient, never as a distribution with zero spread.
- **Someone adds `slippageBps` and `priceImpactBps`.** These overlap: both already contain the pool
  fee. A 2026-09-09 summary decomposed the 86 bps as "pool fee 30 + impact 34 + spread 22", charging
  the pool fee twice and inventing a spread term. This is a repeat-offence failure mode and must be
  prevented by a test, not a comment.
- **The measured distribution is worse than 216 bps.** Expected, since 216 is the optimistic reading.
  Raising the floor is not a founder gate in the dangerous direction, but it does change the M6
  go/no-go, so it must be surfaced, not applied quietly.
- **The measured distribution is better than 216 bps.** This is *lowering the cost model* — an
  explicit founder decision under the constitution, and the most dangerous direction in this
  repository. It must stop and ask, never auto-apply.
- **A venue's cost varies by pool while the model is keyed by venue.** Known true for Splash. The
  report must be able to express a per-pool figure even where the existing model cannot hold one.
- **Depth filtering depends on the floor.** The 34 bps threshold in the depth filter is documented as
  "the price-impact half of the measured round-trip floor". If the floor's basis changes, that
  threshold's justification moves with it and must be re-stated rather than silently orphaned.
- **A distribution built from paper fills inherits paper's limits.** Observations derived from
  simulated fills against observed reserves establish neither real batching latency nor realised
  execution cost. A wider sample does not convert paper into live.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST report round-trip cost as a distribution per route and order-size
  bucket, including at minimum a median and an upper percentile — never as a single point estimate.
- **FR-002**: Every reported figure MUST carry its observation count and the first and last
  observation dates.
- **FR-003**: The system MUST classify each route as having sufficient or insufficient observations,
  and MUST NOT print percentiles for an insufficient route.
- **FR-004**: The system MUST label every figure with the weakest provenance among its components
  (measured or assumed) and MUST NOT include an assumed-component route in any aggregate presented
  as measured.
- **FR-005**: Where a venue is known to under-state its cost, the system MUST state the direction of
  the error alongside the figure.
- **FR-006**: The system MUST NOT combine `slippageBps` and `priceImpactBps` by addition, and this
  MUST be enforced by an automated check that fails if such a combination is reintroduced.
- **FR-007**: The system MUST record, alongside the distribution, that paper-derived observations
  exclude real batching latency and realised execution cost.
- **FR-008**: The system MUST report how many observations the existing 216 bps figure rests on,
  so it can be compared against the new distribution on equal terms.
- **FR-009**: The system MUST expose a per-route, per-size floor lookup that returns either a figure
  with its basis and count, or an explicit insufficiency — never a silent fallback to a global value.
- **FR-010**: The system MUST NOT change any venue fee value, any promotion-gate threshold, or the
  constitution's stated floor as part of this feature. Any proposed change MUST be surfaced as a
  founder decision.
- **FR-011**: The system MUST be able to express a per-pool cost where a venue's cost varies by pool,
  even where the existing venue-keyed model cannot represent it.
- **FR-012**: The system MUST support re-deriving any reported figure from its recorded observations.
- **FR-013**: The system MUST NOT require funds, keys, seed phrases, testnet or mainnet submission,
  or any action that moves value.
- **FR-014**: The system MUST state, for each route it can price, whether that route is eligible for
  execution, applying the exclusion rule in Decisions: a route whose cost cannot be measured is
  excluded and reported as such, so the output answers "what could we actually trade" and not only
  "what did it cost".
- **FR-016**: The headline floor MUST be the 90th percentile of the route-and-size distribution.
  Other percentiles MAY be shown for context, but the figure a minimum-edge control consumes is p90.
- **FR-017**: An excluded venue MUST NOT be silently dropped. The report MUST list every excluded
  route with the reason for exclusion, so the cost of the exclusion policy stays visible.
- **FR-015**: Where the floor's basis changes, the system MUST identify the downstream thresholds
  justified by it (at minimum, the depth filter's price-impact threshold) so none is left orphaned.

### Key Entities

- **Route**: the venue, pool and token pair a trade would execute against. The unit of measurement,
  because cost is not a property of the market as a whole.
- **Order-size bucket**: a band of trade sizes. Cost varies with size through price impact, so a
  figure without a size is not a figure.
- **Cost observation**: one measurement of what a round trip cost on a route at a size, at a time,
  carrying its provenance and the source it was derived from.
- **Cost distribution**: the summary of observations for a route and size — percentiles, count, date
  range, and the weakest basis among its inputs.
- **Basis**: whether a component was measured on chain, documented by a vendor, or assumed. Already
  present in the cost model and extended here to composed figures.
- **Sufficiency verdict**: whether a route has enough observations to be quoted at all.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of cost figures presented to the founder carry an observation count and a date
  range; a figure without both cannot be produced.
- **SC-002**: No route whose components include an assumed value appears in an aggregate labelled
  measured — verified by presenting a known-assumed route and confirming its exclusion.
- **SC-003**: The M6 gate-1 decision can cite either a distribution meeting the sufficiency threshold
  or an explicit statement that the data does not support a conclusion. "2.16%, source unstated" is
  no longer a possible answer.
- **SC-004**: A reviewer given only the report and the recorded observations can reproduce any
  reported figure without consulting the implementation.
- **SC-005**: An attempt to sum the two overlapping bps measures fails an automated check.
- **SC-006**: Every route the bot could execute on is classified as eligible or excluded, with a
  reason, with no route left unclassified.
- **SC-007**: No venue fee value, promotion threshold, or stated floor differs before and after this
  feature, unless a founder decision is recorded.

## Assumptions

- **Sufficiency threshold defaults to 30 observations per route and size bucket**, matching the
  promotion gate's `MIN_ROUND_TRIPS`. Chosen for internal consistency rather than statistical
  derivation; if the distribution proves wide, the threshold should be revisited on evidence.
- **The headline floor is the 90th percentile** (founder decision, below). A floor is a cost that must
  be beaten, so quoting the median would mean half of trades exceed the budget.
- **This feature produces evidence, not a model change.** Under the constitution, lowering or
  re-parameterising the cost model is a founder decision. The deliverable is the distribution plus a
  recommendation; any edit to fee values or thresholds is a separate, explicitly approved step.
- **Observations come from data the project already holds** — collected pool snapshots and candles —
  plus free public chain reads. No new paid data source and no new quota pressure.
- **Paper-derived observations remain paper-derived.** Widening the sample improves the estimate of
  modelled cost; it does not measure realised execution cost, which first becomes measurable at the
  first funded trade.
- **Existing measured venue values stand.** MinswapV2 at 2 ADA and SundaeSwapV3 at 1.28 ADA were
  measured on chain on 2026-09-16 and are not re-litigated here.
- **The existing `docs/specs/` and `docs/plans/` trees are historical record** and are not moved or
  renamed; this feature lives under `specs/002-cost-floor-distribution`.

## Decisions

Both were open when this spec was drafted and were answered by the founder on 2026-09-16. Recorded
here with the reasoning, because each biases every number downstream.

- **D1 - Venues whose cost cannot be measured are EXCLUDED from execution, not modelled with a
  penalty.** Fail closed, consistent with the venue allowlist M6 §7 already requires. The rejected
  alternative was a pessimistic penalty, which requires inventing a margin nobody measured; this
  repository has been damaged twice by exactly that species of number, and a penalty that happens to
  be too small restores the optimism it was meant to remove while looking rigorous. The accepted cost
  is a smaller tradeable universe: on today's table that removes WingRiders, WingRidersV2, VyFinance
  and Splash, leaving MinswapV2 and SundaeSwapV3 as the measured venues. FR-017 keeps the exclusions
  visible so the price of this policy is never hidden.
- **D2 - The floor is the 90th percentile.** A floor describes a trade you can survive, not a typical
  one. At p90, nine of ten round trips land at or under budget. The median was rejected because as a
  floor it means half of all trades exceed what the minimum-edge control sized against — the same
  optimistic bias the single 216 bps observation already carries. **Expect this to make strategies
  look worse than 216 bps did. That is the finding, not a defect**, and it must not become an
  argument for lowering the percentile after the fact.

An implication worth stating: with both decisions applied, the first honest report may well conclude
that no route has enough observations to quote a p90 at all. That is a legitimate and useful outcome.
It is not a reason to relax either decision.
