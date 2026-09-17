# The bootstrap gate's first run against real data, and the prediction it was checked against

Date: 2026-09-17. specs/003 T031-T033, FR-010.

The prediction was written into `specs/003-bootstrap-promotion-gate/research.md` (R9) **before the
check existed**, so that a contradicting result would be investigated rather than absorbed. This
records both halves.

## How it was run, and why not on the box

The box runs `44fa230` and a measurement week is in flight, so nothing was deployed and the live tree
was not touched. `report --compare` would have needed either a deploy or a `/var/tmp` sidecar with
its own `npm ci` — about 120 MB and an install competing with four paper runs on a 2 GB box.

Instead the orders for the six runs were **exported read-only** with a single `psql` query and the
gate was run against them locally. That is faithful: `roundTrips` and `promotionVerdict` are pure
functions of the order rows, which is the whole point of `@ctb/reports` being pure. Runs 150-153 were
not disturbed.

## Predicted, in advance

Every candidate fails on the MINIMUM branch — fewer than 12 paired round trips — and **no run reports
an interval at all**. Nothing promotes.

## Observed

```
MIN_TRIPS_FOR_INTERVAL = 12

run 147: sells=8 pairedTrips=8   8 of 12 round trips: too few to interval
run 149: sells=4 pairedTrips=4   4 of 12 round trips: too few to interval
run 146: sells=2 pairedTrips=2   2 of 12 round trips: too few to interval
run 153: sells=1 pairedTrips=1   1 of 12 round trips: too few to interval
run 151: sells=1 pairedTrips=1   1 of 12 round trips: too few to interval
run   6: sells=1 pairedTrips=1   1 of 12 round trips: too few to interval
```

**The prediction holds on every line.** Six of six fail on the minimum, none reports an interval,
nothing promotes. Per Constitution Principle V that is the design working, not a disappointment.

## One thing the prediction allowed for that did not happen

R8 established that `filledSells` and paired round trips differ in both directions — one sell can
close several FIFO lots, and a sell with no open lot closes none. R9 named that as the likely benign
explanation if a run unexpectedly reported an interval.

**In this data they are equal on all six runs.** That does not retire the distinction: these runs
each open a single lot and close it whole, so the two counts coincide by circumstance rather than by
rule. A strategy that scales into a position will separate them, and the gate now reads the paired
count either way. Recorded so nobody later reads "8 = 8" as evidence the concern was imaginary.

## What this does NOT establish

That the gate is *reliable* at these sample sizes. It is not, and it says so in its own output:
`bootstrap.ts` measures 79-93% coverage where 95% is claimed, and its conclusion — "the constraint is
the trade count, not the estimator" — is unaffected by anything here. Every run in this table failed
for want of evidence, which is the only verdict this much data can support.
