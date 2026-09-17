# Specification Quality Checklist: Bootstrap the promotion gate's round-trip evidence

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

Three judgement calls recorded rather than hidden.

1. **"No implementation details" passes, and the first draft did not.** The draft named source
   paths and exported symbols throughout. They were removed on review, for the same reason
   specs/002 kept only domain quantities: a spec that names the file it expects to be edited has
   pre-decided the design. The remaining named things are domain quantities and documents, not
   code. One consequence is deliberate — the spec never names the constant it is replacing, only
   "a fixed constant of thirty", so the plan is free to retain, move or delete the symbol.

2. **The parameter values are deliberately NOT in this spec.** Confidence level and resample count
   appear in Assumptions as reasonable defaults; the minimum trip count appears only as a
   requirement that it be pre-registered and justified (FR-004). Fixing a number here would look
   rigorous and would in fact be the exact failure the feature exists to avoid — choosing
   parameters before the procedure is settled, then being unable to distinguish that from choosing
   them until something passes. The plan pre-registers them, with the justification, before the
   procedure meets real data.

3. **One requirement asserts a fact about existing code that the plan MUST verify.** FR-003 says
   round-trip returns are already after-cost, so zero is the correct comparand and subtracting a
   cost floor again would double-count. That was read off the pairing during specification, but
   Assumptions restates it as something to verify against the code rather than to take from the
   spec. If it turns out false, FR-002 and FR-003 both change, so it is the first thing planning
   should check.

## Scope note

`beats-baselines` gaining its own significance test is explicitly OUT of scope and left as a later
decision. This feature changes what counts as sufficient evidence of an edge; it does not change
how that edge is compared against the baselines.
