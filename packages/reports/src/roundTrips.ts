import type { OrderRecord } from '@ctb/engine';

/**
 * Pairs each filled buy to the sell that closes it, FIFO, so a run can be read as a DISTRIBUTION of
 * completed trades rather than one aggregate number. Six small losses and one lucky win produce the
 * same run-level return as seven mediocre trades, and only one of those is a strategy.
 *
 * It is also the unit the promotion gate measures in (`promotion.ts` counts round trips) and the
 * prerequisite for the two things that gate still lacks: a bootstrap interval on the edge, and a
 * check on the normality assumption behind its n = 30 threshold.
 */
export interface RoundTrip {
  openSeq: number;
  closeSeq: number;
  openedAt: Date;
  closedAt: Date;
  holdMs: number;
  /** Lovelace spent opening this portion, INCLUDING its share of the buy leg's fees. */
  costLovelace: bigint;
  /** Lovelace received closing it, NET of its share of the sell leg's fees. */
  proceedsLovelace: bigint;
  /** `(proceeds / cost - 1)` in basis points, two decimal places. */
  returnBps: number;
  /** Base-token units opened and closed. */
  baseUnits: bigint;
}

export interface RoundTripStats {
  trips: number;
  /** Sells arriving with no open lot. Never silently dropped: it means the pairing saw a position
   * it did not open, which is either a resumed run or a defect, and both are worth seeing. */
  unmatchedSells: number;
  /** Buys still open at the end — capital the run never got back, and not a round trip. */
  openLots: number;
  medianReturnBps: number | null;
  meanReturnBps: number | null;
  /** Sample standard deviation. Needs 2 trips; null below that rather than 0. */
  stdevBps: number | null;
  medianAbsReturnBps: number | null;
  /**
   * The σ that `medianAbsReturnBps` implies IF the returns are normal, via `median|X| ≈ 0.6745σ`.
   *
   * It exists to be read against `stdevBps`. The promotion gate's n = 30 came from exactly that
   * conversion applied to a median price move, and the conversion holds only for a normal
   * distribution. If these two disagree, the arithmetic behind the threshold does not hold.
   */
  normalImpliedStdevBps: number | null;
  /**
   * Excess kurtosis (0 for a normal distribution, positive for fat tails). Needs 4 trips.
   *
   * Deliberately included because it is DIMENSIONLESS. The only corpora with enough round trips
   * today are backtests over external, USD-denominated candles, so any σ taken from them is in the
   * wrong currency and must not be quoted. Kurtosis survives that: the fat-tail question can be
   * answered from data whose scale cannot be.
   */
  excessKurtosis: number | null;
}

/** Two decimal places of a basis point, in bigint so a large lovelace amount keeps its precision. */
function bps(cost: bigint, proceeds: bigint): number {
  return Number(((proceeds - cost) * 1_000_000n) / cost) / 100;
}

interface Lot { seq: number; at: Date; baseRemaining: bigint; costRemaining: bigint }

export function roundTrips(orders: readonly OrderRecord[]): RoundTrip[] {
  const open: Lot[] = [];
  const trips: RoundTrip[] = [];

  for (const o of [...orders].sort((a, b) => a.seq - b.seq)) {
    if (o.result.status !== 'filled') continue;
    const legFees = o.result.batcherFeeLovelace + o.result.networkFeeLovelace;

    if (o.intent.side === 'buy') {
      // Cost is what left the wallet: the lovelace swapped in, plus the fees on this leg.
      if (o.result.amountOut > 0n) {
        open.push({ seq: o.seq, at: o.result.tsFill, baseRemaining: o.result.amountOut, costRemaining: o.result.amountIn + legFees });
      }
      continue;
    }

    let baseToClose = o.result.amountIn;
    const proceedsTotal = o.result.amountOut - legFees;
    const baseSold = o.result.amountIn;
    while (baseToClose > 0n && open.length > 0) {
      const lot = open[0]!;
      const take = baseToClose < lot.baseRemaining ? baseToClose : lot.baseRemaining;
      // Both sides split PRO RATA by base units, so a partial close carries its own share of the
      // buy's fees and of the sell's proceeds rather than all of either.
      const cost = (lot.costRemaining * take) / lot.baseRemaining;
      const proceeds = baseSold > 0n ? (proceedsTotal * take) / baseSold : 0n;
      if (cost > 0n) {
        trips.push({
          openSeq: lot.seq, closeSeq: o.seq, openedAt: lot.at, closedAt: o.result.tsFill,
          holdMs: o.result.tsFill.getTime() - lot.at.getTime(),
          costLovelace: cost, proceedsLovelace: proceeds, returnBps: bps(cost, proceeds), baseUnits: take,
        });
      }
      lot.costRemaining -= cost;
      lot.baseRemaining -= take;
      baseToClose -= take;
      if (lot.baseRemaining <= 0n) open.shift();
    }
  }
  return trips;
}

const quantile = (sorted: number[], q: number): number => {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};

/** `median|X| ≈ 0.6745σ` for a normal distribution — the conversion the n = 30 threshold rests on. */
const MEDIAN_ABS_TO_SIGMA = 0.6745;

export function roundTripStats(orders: readonly OrderRecord[], trips: readonly RoundTrip[]): RoundTripStats {
  let unmatchedSells = 0;
  let openBase = 0n;
  let closedBase = 0n;
  let lots = 0;
  for (const o of orders) {
    if (o.result.status !== 'filled') continue;
    if (o.intent.side === 'buy') { openBase += o.result.amountOut; lots++; }
    else if (openBase - closedBase <= 0n) unmatchedSells++;
    else closedBase += o.result.amountIn;
  }
  const closedLots = new Set(trips.filter((t) => t.baseUnits > 0n).map((t) => t.openSeq));
  let fullyClosed = 0;
  for (const seq of closedLots) {
    const opened = orders.find((o) => o.seq === seq);
    if (opened?.result.status === 'filled') {
      const sold = trips.filter((t) => t.openSeq === seq).reduce((a, t) => a + t.baseUnits, 0n);
      if (sold >= opened.result.amountOut) fullyClosed++;
    }
  }

  const rs = trips.map((t) => t.returnBps);
  const n = rs.length;
  const base: RoundTripStats = {
    trips: n, unmatchedSells, openLots: lots - fullyClosed,
    medianReturnBps: null, meanReturnBps: null, stdevBps: null,
    medianAbsReturnBps: null, normalImpliedStdevBps: null, excessKurtosis: null,
  };
  if (n === 0) return base;

  const sorted = [...rs].sort((a, b) => a - b);
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sortedAbs = rs.map(Math.abs).sort((a, b) => a - b);
  const medianAbs = quantile(sortedAbs, 0.5);
  const m2 = rs.reduce((a, r) => a + (r - mean) ** 2, 0) / n;
  return {
    ...base,
    medianReturnBps: quantile(sorted, 0.5),
    meanReturnBps: mean,
    // Sample standard deviation (n - 1): needs two trips, and is null rather than 0 below that.
    stdevBps: n >= 2 ? Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1)) : null,
    medianAbsReturnBps: medianAbs,
    normalImpliedStdevBps: medianAbs / MEDIAN_ABS_TO_SIGMA,
    // Excess kurtosis needs a fourth moment to mean anything; four trips is already generous.
    excessKurtosis: n >= 4 && m2 > 0 ? rs.reduce((a, r) => a + (r - mean) ** 4, 0) / n / m2 ** 2 - 3 : null,
  };
}
