# Phase 1 data model

No persisted entities. Nothing here is stored, migrated or written; every structure below is computed
in memory from orders that already exist.

---

## RoundTripReturn (existing, reused)

One completed buy-to-sell pair, produced by `roundTrips()`. The unit of evidence.

| Field | Type | Notes |
|---|---|---|
| `returnBps` | number | **After-cost.** Net of pool fee, price impact, batcher fee and network fee (research R1). This is the only field the interval consumes. |

**Validation rules**

- The input to the interval is `RoundTrip[].map(t => t.returnBps)` — **paired round trips, never
  `filledSells`**. R8: one sell can close several FIFO lots and a sell with no open lot closes none,
  so the two counts differ in both directions.
- Only ADA-denominated paper runs are eligible. A backtest over external USD candles must never reach
  the interval; a USD return compared against an ADA-costed zero is meaningless (Constitution II).
- Order within the array is irrelevant to the statistic but **must be stable** for determinism: the
  same run must produce the same array in the same order on every evaluation. `roundTrips()` already
  sorts by `seq`.

---

## EvidenceInterval (new)

The result of the bootstrap. Carries its own provenance so a verdict can be audited without reading
the source (FR-006, SC-004).

| Field | Type | Notes |
|---|---|---|
| `lowerBps` | number | Lower bound of the BCa interval on the mean. |
| `upperBps` | number | Upper bound. |
| `meanBps` | number | The observed statistic, not a resampled one. |
| `trips` | number | How many round trips it was computed from. |
| `confidencePct` | number | 95. Recorded, not assumed by the reader. |
| `resamples` | number | 10,000. |

**Validation rules**

- `lowerBps <= upperBps` always, including the degenerate case where they are equal.
- Never produced when `trips < MIN_TRIPS_FOR_INTERVAL`. Absence is the signal; a bound computed below
  the minimum would read as evidence (spec US2 scenario 1).
- Bounds are finite. **`NaN` is a defect, not a value** — the specific path that produces one is the
  zero-variance jackknife in BCa's acceleration term, which must be detected and handled as the
  degenerate interval `[mean, mean]` (research R6). A `NaN` bound compares false against zero and
  would fail closed for the wrong reason, which is worse than failing loudly.

---

## PromotionInput (existing, extended)

| Field | Change | Notes |
|---|---|---|
| `roundTripReturnsBps` | **added**, `readonly number[]` | The paired after-cost returns. Empty array means no evidence, which is distinct from the field being absent. |
| `filledSells` | **kept** | Still printed by the report. No longer decides the check. Deliberately not removed: unrelated churn. |

**Validation rules**

- The gate MUST NOT infer round trips from `filledSells` (R8).
- An absent or empty `roundTripReturnsBps` fails the check on the minimum branch, with no interval.

---

## PromotionCheck (existing, unchanged shape)

| Field | Notes |
|---|---|
| `id` | Stays `'round-trips'` (research R8). No type change, no consumer churn. |
| `passed` | True only when an interval exists AND `lowerBps > 0`. |
| `detail` | **Must distinguish the two failure branches** (FR-007): too few trips, versus enough trips with an interval spanning zero. In the second case it reports the interval. |

**State transitions** — the check resolves to exactly one of three outcomes, and there is no fourth:

```
baseline strategy        -> failed, "is a baseline, not a promotion candidate"   (existing, wins)
trips < minimum          -> failed, names the count and the minimum, NO interval
trips >= minimum, CI     -> passed  when lowerBps > 0
                         -> failed  otherwise, reporting the interval
```

The first branch short-circuits before any interval is computed, preserving today's behaviour that a
baseline is never a candidate regardless of its returns.
