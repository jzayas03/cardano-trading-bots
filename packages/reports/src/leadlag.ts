/**
 * Does on-chain structure LEAD price?
 *
 * We store what most traders cannot see: pool depth (`tvl_lovelace`), both reserves, and net swap
 * flow, per token per candle. This asks whether any of those move BEFORE price does — because a
 * signal that moves at the same time as price is not tradeable, and one that lags it is useless.
 *
 * This module answers a research question, not a trading one. Correlation here is necessary and
 * nowhere near sufficient: a relationship must also predict a move larger than the 2.16% round-trip
 * cost before it is worth anything.
 *
 * Everything is a pure function of its inputs so the statistics can be tested without a database.
 */

/** Pearson r, or null when it is undefined (fewer than 3 points, or a series with no variance). */
export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]!; sy += y[i]!; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i]! - mx, b = y[i]! - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  // A flat series has no correlation with anything. Returning 0 would claim "no relationship";
  // null says "the question does not apply", which is the truth and forces the caller to handle it.
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export interface LagCorrelation {
  /** Positive lag = structure at time t against the price return at t+lag, i.e. structure LEADS. */
  lag: number;
  r: number;
  n: number;
}

/**
 * Correlate a structure series against a return series at every lag in [-maxLag, +maxLag].
 *
 * A positive lag means structure came FIRST. Lag 0 means they move together, which is not a signal
 * you can trade. Negative lags mean price led, which is the opposite of useful — but they are
 * computed and reported anyway, because a peak at a negative lag is the clearest possible evidence
 * that a "predictor" is really just an echo.
 */
export function crossCorrelation(structure: readonly number[], returns: readonly number[], maxLag: number): LagCorrelation[] {
  const out: LagCorrelation[] = [];
  const len = Math.min(structure.length, returns.length);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < len; i++) {
      const j = i + lag;
      if (j < 0 || j >= len) continue;
      xs.push(structure[i]!);
      ys.push(returns[j]!);
    }
    const r = pearson(xs, ys);
    if (r !== null) out.push({ lag, r, n: xs.length });
  }
  return out;
}

/**
 * The |r| a correlation must exceed to be worth a second look, given the sample AND how many
 * correlations were computed to find it.
 *
 * The ~2/sqrt(n) rule is the 95% threshold for ONE test. We run (2*maxLag + 1) lags per metric per
 * token, so the largest of hundreds of draws will clear that bar by chance alone — this is the
 * mechanism by which backtests discover strategies that never existed. A Bonferroni-style widening
 * by sqrt(comparisons) is crude and conservative, which is the right direction to be wrong in when
 * the alternative is trading on noise.
 */
export function significanceThreshold(n: number, comparisons: number): number {
  if (n < 3) return Infinity;
  return (2 / Math.sqrt(n)) * Math.sqrt(Math.max(1, comparisons));
}

export type LeadLagVerdict =
  | { kind: 'underpowered'; n: number; needed: number }
  | { kind: 'no signal'; best: LagCorrelation; threshold: number }
  | { kind: 'contemporaneous'; best: LagCorrelation; threshold: number }
  | { kind: 'price leads'; best: LagCorrelation; threshold: number }
  | { kind: 'structure leads'; best: LagCorrelation; threshold: number };

/** Below this many observations the answer is "we do not know", never a correlation. */
export const MIN_SAMPLE = 200;

/**
 * Reduce a set of lag correlations to one honest verdict.
 *
 * Fails closed in the direction that matters: too little data returns `underpowered` rather than a
 * number, because a small sample does not produce a weak answer — it produces a confident wrong one.
 */
export function interpret(results: readonly LagCorrelation[], comparisons: number, minSample = MIN_SAMPLE): LeadLagVerdict {
  if (results.length === 0) return { kind: 'underpowered', n: 0, needed: minSample };
  const n = Math.max(...results.map((r) => r.n));
  if (n < minSample) return { kind: 'underpowered', n, needed: minSample };

  const best = results.reduce((a, b) => (Math.abs(b.r) > Math.abs(a.r) ? b : a));
  const threshold = significanceThreshold(best.n, comparisons);
  if (Math.abs(best.r) < threshold) return { kind: 'no signal', best, threshold };
  if (best.lag === 0) return { kind: 'contemporaneous', best, threshold };
  if (best.lag < 0) return { kind: 'price leads', best, threshold };
  return { kind: 'structure leads', best, threshold };
}

/** Simple returns from a price series: r[i] = p[i+1]/p[i] - 1. One shorter than its input. */
export function returnsOf(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    out.push(prev === 0 ? 0 : prices[i]! / prev - 1);
  }
  return out;
}

/** Fractional change of a structure series, so TVL in lovelace and flow in tokens are comparable. */
export function changesOf(values: readonly number[]): number[] {
  return returnsOf(values);
}
