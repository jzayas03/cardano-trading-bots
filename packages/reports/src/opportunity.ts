/**
 * Does the price move more than it costs to trade?
 *
 * That is the question the whole project rests on, and until 2026-09-08 this repo could only answer
 * half of it. Every candle it had ever written was built from ONE snapshot, so open = high = low =
 * close in 2,306 of 2,306 cases and the intra-candle range was zero BY CONSTRUCTION. Only
 * close-to-close was measurable, and `docs/ops/2026-09-08-token-choice.md` measured it by hand over
 * GeckoTerminal data to choose SNEK.
 *
 * With tiered sampling a candle holds several samples and has a real high and low, so the sharper
 * question opens up: how often does the range INSIDE a candle clear the floor when the close-to-close
 * move does not? That gap is the opportunity a close-only strategy leaves on the table.
 *
 * Two rules carried over from that document rather than reinvented, both learned the hard way:
 *
 *  - A window is a fixed DURATION, never a fixed number of bars. A first attempt compared moves over
 *    N bars and had to be thrown away: a feed that writes no row without a trade makes a "bar" ten
 *    minutes for one token and hours for another, so it ranked the sparsest tokens highest. That is
 *    an artefact of sparsity, not a property of the market.
 *  - Windows must be contiguous. A gap usually means the collector was down, and a return measured
 *    across one describes our outage rather than the price.
 *
 * What this does NOT claim: that a strategy can capture any of it. Moves of sufficient size existing
 * is a necessary condition, not a sufficient one.
 */

/** Round-trip cost floor in basis points, measured 2026-09-08 from run 139's first real fill:
 *  86 bps slippage (34 of it our own price impact) + 22 bps batcher and network, one way = 108.
 *  `docs/specs/2026-09-08-m6-execution.md` §2. Cited, never re-derived here — a second cost model
 *  living in a report is how two numbers start disagreeing. */
export const DEFAULT_FLOOR_BPS = 216;

/** The minimum samples a candle needs before its high and low mean anything. One sample gives
 *  open = high = low = close, and a range of zero that was never measured. */
export const MIN_SAMPLES_FOR_RANGE = 2;

export interface OpportunityCandle {
  tickTs: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Snapshots behind this candle, for its OWN pool inside its own bucket. `buildCandles` takes
   *  prices only from the deepest pool in the bucket, so a count across pools would overstate it. */
  samples: number;
}

export interface IntraCandleStats {
  /** Candles with enough samples for the range to be a measurement rather than an artefact. */
  measurable: number;
  /** Candles whose range is zero because nothing was sampled twice. Reported separately and never
   *  folded into the denominator: a 0% that means "not measured" reads as "no opportunity". */
  notMeasurable: number;
  clearing: number;
  /** null, not 0, when nothing is measurable. */
  pctClearing: number | null;
  medianRangeBps: number | null;
  p90RangeBps: number | null;
  /**
   * Candles whose intra-candle range clears the floor while their own open-to-close move does not.
   * The headline number: what a strategy reading closes alone cannot see.
   */
  missedByCloseOnly: number;
}

export interface WindowStats {
  seconds: number;
  windows: number;
  clearing: number;
  pctClearing: number | null;
  medianAbsBps: number | null;
  /** Windows rejected because a candle inside them was missing. Information, not noise: a large
   *  number here means the collector had gaps and every other figure rests on less data. */
  skippedForGaps: number;
}

export interface OpportunityReport {
  floorBps: number;
  candles: number;
  intraCandle: IntraCandleStats;
  windows: WindowStats[];
}

export interface OpportunityOptions {
  floorBps?: number;
  /** The candle interval, passed rather than inferred. Inferring it from the data is what produced
   *  the bars-not-duration mistake described above. */
  candleIntervalSec: number;
  /** Window durations in seconds. */
  windowSecs: readonly number[];
}

/** (high - low) / low, in basis points. Uses low as the base so the figure is the gain available to
 *  someone who bought the low, which is the quantity the cost floor is compared against. */
export function rangeBps(c: Pick<OpportunityCandle, 'high' | 'low'>): number {
  if (!(c.low > 0) || !Number.isFinite(c.high) || !Number.isFinite(c.low)) return 0;
  return ((c.high - c.low) / c.low) * 10_000;
}

/** Signed open-to-close move in basis points. */
export function bodyBps(c: Pick<OpportunityCandle, 'open' | 'close'>): number {
  if (!(c.open > 0) || !Number.isFinite(c.close)) return 0;
  return ((c.close - c.open) / c.open) * 10_000;
}

/** Linear-interpolated quantile of an unsorted array. Returns null for an empty one — a quantile of
 *  nothing is not zero. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

function pct(part: number, whole: number): number | null {
  return whole === 0 ? null : (part / whole) * 100;
}

/**
 * One token's candles, sorted ascending by `tickTs` and all from the same token. Sorting is the
 * caller's job (the SQL already orders); this asserts it rather than silently producing nonsense.
 */
export function opportunity(candles: readonly OpportunityCandle[], opts: OpportunityOptions): OpportunityReport {
  const floorBps = opts.floorBps ?? DEFAULT_FLOOR_BPS;
  const intervalMs = opts.candleIntervalSec * 1000;
  if (!(intervalMs > 0)) throw new Error(`candleIntervalSec must be positive, got ${opts.candleIntervalSec}`);
  // Invalid dates are rejected explicitly, and this is not belt-and-braces. `new Date('bad')` gives
  // NaN, and the sortedness check below cannot catch it because every comparison against NaN is
  // false. NaN then flows into `closeByTick`, where Map key equality is SameValueZero -- so ALL
  // entries collapse onto the single key NaN, `has(NaN)` answers true for every contiguity probe,
  // and the report invents a full set of windows out of two candles. Found by running this against
  // live data, where a Postgres timestamp rendered as `+00` (not `+00:00`) parsed to Invalid Date.
  for (let i = 0; i < candles.length; i++) {
    if (!Number.isFinite(candles[i]!.tickTs.getTime())) {
      throw new Error(`candle ${i} has an invalid tickTs; an unparseable date silently fabricates windows`);
    }
  }
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.tickTs.getTime() <= candles[i - 1]!.tickTs.getTime()) {
      throw new Error(`candles must be sorted ascending and unique by tickTs; index ${i} is not later than ${i - 1}`);
    }
  }

  const measurableRanges: number[] = [];
  let notMeasurable = 0;
  let clearing = 0;
  let missedByCloseOnly = 0;
  for (const c of candles) {
    if (c.samples < MIN_SAMPLES_FOR_RANGE) {
      notMeasurable++;
      continue;
    }
    const r = rangeBps(c);
    measurableRanges.push(r);
    if (r >= floorBps) {
      clearing++;
      if (Math.abs(bodyBps(c)) < floorBps) missedByCloseOnly++;
    }
  }

  const closeByTick = new Map<number, number>();
  for (const c of candles) closeByTick.set(c.tickTs.getTime(), c.close);

  const windows: WindowStats[] = opts.windowSecs.map((seconds) => {
    const spanMs = seconds * 1000;
    if (spanMs % intervalMs !== 0) {
      throw new Error(`window ${seconds}s is not a whole number of ${opts.candleIntervalSec}s candles`);
    }
    const steps = spanMs / intervalMs;
    const moves: number[] = [];
    let skippedForGaps = 0;
    for (const c of candles) {
      const t0 = c.tickTs.getTime();
      let contiguous = true;
      for (let k = 1; k <= steps; k++) {
        if (!closeByTick.has(t0 + k * intervalMs)) { contiguous = false; break; }
      }
      const end = closeByTick.get(t0 + spanMs);
      if (!contiguous || end === undefined) {
        // Only count a gap when the window could otherwise have existed, i.e. its end is inside the
        // data. Windows that simply run off the end of the series are not gaps.
        if (t0 + spanMs <= (candles.at(-1)?.tickTs.getTime() ?? -Infinity)) skippedForGaps++;
        continue;
      }
      if (!(c.close > 0)) continue;
      moves.push(Math.abs(((end - c.close) / c.close) * 10_000));
    }
    const cleared = moves.filter((m) => m >= floorBps).length;
    return {
      seconds, windows: moves.length, clearing: cleared,
      pctClearing: pct(cleared, moves.length),
      medianAbsBps: quantile(moves, 0.5),
      skippedForGaps,
    };
  });

  return {
    floorBps,
    candles: candles.length,
    intraCandle: {
      measurable: measurableRanges.length,
      notMeasurable,
      clearing,
      pctClearing: pct(clearing, measurableRanges.length),
      medianRangeBps: quantile(measurableRanges, 0.5),
      p90RangeBps: quantile(measurableRanges, 0.9),
      missedByCloseOnly,
    },
    windows,
  };
}
