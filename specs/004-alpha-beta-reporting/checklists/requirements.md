# Specification Quality Checklist: Exposure-adjusted comparison — alpha and beta, reported

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-17
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

Four judgement calls recorded rather than hidden.

1. **Written in domain language from the first draft, deliberately.** The previous feature's spec had
   to be rewritten because it named source files and exported symbols throughout, which pre-decides
   the design. This one was checked mechanically before validation: zero source paths, zero symbol
   names. The cost is that a reader must map "the run's own recorded prices" onto a field themselves;
   the benefit is that the plan is free to choose where the measurement lives.

2. **The single-benchmark decision is an assumption, not a requirement, and it is the one most likely
   to be revisited.** Alpha is measured against holding the token alone, with the accumulation
   baseline left as a separate scalar comparison. The reason is stated in the spec: a two-benchmark
   attribution invites the two to be summed, and this project has already been damaged by two
   overlapping cost measures being added together. If planning finds a defensible two-factor form,
   that is a spec revision, not an implementation choice.

3. **Two requirements exist to prevent this feature earning credit it did not earn.** FR-005 charges
   idle cash an opportunity cost, without which a strategy that sits in cash is handed free alpha;
   FR-006 forces the assumed rate into the open, because an assumption hidden inside a headline is
   how a number stops being questioned. Neither is a statistical nicety — both change the sign of the
   answer for a strategy that is mostly in cash, which describes most of the candidates.

4. **FR-008's "effective observation count" is the requirement most likely to be quietly dropped**,
   because it makes the feature look weaker. A week of observations recorded every few minutes is
   roughly a thousand points and nowhere near a thousand independent ones. Reporting the raw count
   would overstate the evidence in exactly the way a previously published memory figure was
   overstated by counting shared pages repeatedly. Success criterion SC-004 pins it numerically so it
   cannot be satisfied by a footnote.

## Scope note

Wiring alpha into the promotion gate is explicitly OUT of scope and is a founder stop-and-ask under
the constitution. This feature changes what the report *says*; it changes nothing about what the gate
*decides*, and FR-012 requires that invariance be enforced by test.
