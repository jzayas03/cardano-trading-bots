# Feature Specification: Exposure-adjusted comparison — alpha and beta, reported

**Feature Branch**: `feat/alpha-beta-reporting`

**Created**: 2026-09-17

**Status**: Draft

**Input**: Founder decision 2026-09-17 — measure alpha and beta against holding the token, and
report them **without changing what promotes**.

## Why this exists

The gate's baseline check compares a single token-denominated return against both baselines and
demands the candidate beat each one strictly. It makes **no adjustment for how much market exposure
the candidate took**.

That matters because the strategies under test differ enormously in exposure by construction. The
scheduled-accumulation baseline is essentially always long. A moving-average crossover sits in cash a
large fraction of the time. Comparing their raw returns treats a half-exposed strategy and a fully
exposed one as equivalent, so the check **cannot distinguish skill from bought exposure** — and
"bought exposure" is something the founder could obtain more cheaply by simply holding the token.

Alpha is the principled form of the question that check is already asking. Beta is the number that
says how much of the answer was exposure.

**This feature does not change what is promoted.** It measures and reports. Wiring alpha into the
gate is a change to the promotion gate's criteria, which is a founder decision under the
constitution's stop-and-ask list, and it is explicitly **out of scope** here.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tell skill apart from bought exposure (Priority: P1)

The founder reads a run's report and wants to know whether its return came from judgement or from
having been long while the token happened to rise. Today the report shows a return and a comparison;
neither separates the two.

**Why this priority**: It is the entire point of the feature, and it is the question the existing
baseline comparison is trying and failing to answer.

**Independent Test**: Construct a run that is a pure holder of the token and one that produces return
uncorrelated with the token, and confirm the reported numbers separate them — the holder shows a beta
near one and alpha near zero, the other does not.

**Acceptance Scenarios**:

1. **Given** a paper run whose equity tracks the token one-for-one, **When** its report is read,
   **Then** beta is approximately one and alpha is approximately zero after costs and the cash
   opportunity charge.
2. **Given** a paper run that spent half the window in cash, **When** its report is read, **Then**
   beta is materially below one and the report says what fraction of the window carried exposure.
3. **Given** two runs with the same headline return but different exposure, **When** both reports are
   read, **Then** their alphas differ, and the direction is explicable from the exposure difference.

---

### User Story 2 - Say plainly when the data cannot answer (Priority: P2)

Equity observations arrive every few minutes and are strongly serially correlated, so a run's raw
observation count wildly overstates how much independent evidence it holds. The founder needs the
report to distinguish "alpha is approximately zero" from "this window cannot tell you".

**Why this priority**: Without it the feature produces its most dangerous output — a confident-looking
alpha resting on evidence that does not exist. The project has already published one number
(a memory saving) that was inflated by counting shared things repeatedly; the same error in a return
attribution would be harder to spot.

**Independent Test**: Feed a short and a long window of the same underlying behaviour and confirm the
reported uncertainty widens on the short one, and that an uninformative result is labelled as such
rather than printed as a number.

**Acceptance Scenarios**:

1. **Given** any run, **When** its report is read, **Then** the uncertainty on alpha is shown beside
   the estimate, never the estimate alone.
2. **Given** a window whose uncertainty on alpha spans zero, **When** the report is read, **Then** it
   states that the window cannot distinguish alpha from zero, rather than implying a finding.
3. **Given** a run, **When** the report is read, **Then** it reports an **effective** number of
   independent observations, and that figure is lower than the raw count whenever the observations
   are correlated.
4. **Given** a run whose exposure changed markedly during the window, **When** the report is read,
   **Then** the instability of beta is reported rather than averaged into one number.

---

### User Story 3 - Promotion outcomes are provably unchanged (Priority: P3)

The founder approved this feature on the condition that it is additive. They need to see that
condition enforced by something other than intent.

**Why this priority**: Independently testable, and it is the condition the feature was approved
under. Listed last only because it is the absence of a change rather than a capability.

**Independent Test**: Run the promotion verdict over every existing case before and after the
feature, and confirm the status, the checks and the blockers are identical.

**Acceptance Scenarios**:

1. **Given** any run, **When** its promotion verdict is computed, **Then** its status, its list of
   checks and its list of blockers are identical to what they were before this feature existed.
2. **Given** a run whose alpha is strongly positive, **When** its verdict is computed, **Then** the
   verdict is unaffected — a strong alpha promotes nothing on its own.

---

### Edge Cases

- **A backtest.** Backtests record orders but no equity observations, so this measurement is not
  possible for them. The report must say the measurement does not apply, not silently omit it or
  print zeros.
- **A run with fewer than two equity observations**, or one whose window holds no price movement at
  all: no slope is defined. Refuse rather than divide by zero.
- **A run that never took a position.** Beta is zero by construction and alpha is whatever the cash
  earned against the charge; the report should make clear this is a definitional result, not a
  measurement of skill.
- **A token price that did not move** across the window: beta is undefined, and a large apparent
  alpha is an artefact. Refuse.
- **A run still in progress**: the window is partial, and the report must say the window is open
  rather than presenting a partial window as a result.
- **Mixed tokens across compared runs**: alpha is only comparable within one token, as the existing
  return comparison already is.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST report, for each paper run, an alpha, a beta, and an uncertainty
  interval on alpha.
- **FR-002**: Beta MUST be measured against **holding the token**, using the run's own recorded
  ADA-denominated prices as the benchmark series.
- **FR-003**: The system MUST NOT use externally sourced price history for the benchmark. External
  history is denominated in a different currency from internal accounting, and mixing them has
  already produced a meaningless comparison once in this project's history.
- **FR-004**: Every reported figure MUST state its denomination. The system MUST NOT estimate in one
  denomination and present the result as though it were in another.
- **FR-005**: Idle cash MUST be charged an opportunity cost for the yield it forgoes. Without this a
  strategy that sits in cash is credited with alpha it did not earn.
- **FR-006**: The assumed yield rate used for FR-005 MUST be shown alongside the result, never folded
  silently into the headline figure.
- **FR-007**: The uncertainty interval on alpha MUST account for serial correlation between
  observations. An interval computed as though consecutive observations were independent would be
  misleadingly narrow.
- **FR-008**: The system MUST report an **effective** number of independent observations, distinct
  from the raw observation count.
- **FR-009**: The system MUST report whether beta was stable across the window, rather than
  presenting a single averaged figure for a strategy whose exposure varied.
- **FR-010**: When the interval on alpha spans zero, the system MUST say the window cannot
  distinguish alpha from zero, rather than presenting the point estimate as a finding.
- **FR-011**: The system MUST refuse, with a stated reason, when the measurement is not defined:
  fewer than two observations, no price movement, or a run type that records no equity.
- **FR-012**: The promotion verdict's status, checks and blockers MUST be unchanged by this feature
  for every input. This MUST be enforced by a test, not by intent.
- **FR-013**: The gate MUST continue to report every check and list every blocker rather than the
  first.
- **FR-014**: The feature MUST NOT change any venue cost value, the default cost floor, the default
  maximum price impact, the round-trip evidence threshold, or the constitution's stated 216 bps. Any
  proposal to do so is a stop-and-ask, never an edit.
- **FR-015**: The feature MUST reuse the project's existing resampling machinery for the interval
  rather than introducing a second implementation.
- **FR-016**: The feature MUST require no schema change and MUST write nothing. The equity record
  already holds everything needed.

### Key Entities

- **Equity observation**: one recorded point in a run's life — timestamp, cash held, position held,
  total value, and the token's price at that moment. Already persisted for paper runs.
- **Benchmark series**: the token's own ADA price across the same observations. The thing a strategy
  is being compared against.
- **Exposure-adjusted result**: alpha, beta, the interval on alpha, the effective observation count,
  the beta-stability indication, and the assumed yield rate that produced the cash charge.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a run that simply holds the token, the reported beta is within a stated tolerance
  of one and the reported alpha is within a stated tolerance of zero.
- **SC-002**: For two runs with equal headline returns and materially different exposure, the reports
  show different alphas.
- **SC-003**: Every reported alpha is accompanied by an uncertainty interval; no report presents a
  point estimate alone.
- **SC-004**: The reported effective observation count is strictly lower than the raw count for every
  run whose observations are correlated.
- **SC-005**: Promotion status is identical for every run before and after this feature, demonstrated
  by test rather than asserted.
- **SC-006**: A reader can state, from the report alone, the denomination of every figure and the
  assumed yield rate behind the cash charge.
- **SC-007**: No figure in the cost model changes, demonstrated by inspecting the change set.

## Assumptions

- **Alpha is measured against holding the token alone**, a single benchmark. The scheduled-
  accumulation baseline remains a separate scalar comparison and is **not** folded into this
  measurement. Rationale: a two-benchmark attribution invites the two to be summed or traded off, and
  this project has already been damaged once by two overlapping cost measures being added together.
  Revisiting this is a planning question, not a silent implementation choice.
- **Paper runs only.** Backtests record no equity observations, so the measurement cannot apply to
  them. This is stated in the report rather than left as an empty column.
- **The existing assumed staking yield is the opportunity-cost rate**, reusing the rate the reports
  already show for idle ADA rather than introducing a second assumed rate that could drift from it.
- **Returns are computed from consecutive equity observations** at whatever interval the run
  recorded, and the effective observation count is what makes that interval's redundancy visible.
- **The reporting surface is the existing run report and comparison output.** No new command is
  introduced.
- No funds, no keys, no seed phrase, no preprod, no mainnet. Nothing in this feature moves value.
- The reporting layer stays pure; the measurement is a pure function of already-recorded observations.
- The Postgres-enabled test suite is the gate. A run of the default suite skips those tests and is not
  evidence.

## Out of Scope

- **Wiring alpha into the promotion gate.** That changes what promotion means and is a founder
  stop-and-ask under the constitution. This feature deliberately leaves the baseline comparison
  deciding promotion exactly as it does today.
- Replacing or modifying the round-trip evidence check delivered by the previous feature.
- Any change to the cost model.
- Multi-factor attribution, risk-adjusted ratios, or drawdown-based measures.
