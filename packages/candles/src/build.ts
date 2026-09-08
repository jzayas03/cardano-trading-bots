import { priceAdaPerToken } from './price.js';
import type { CandleRow, SnapshotForCandle } from './types.js';

type Previous = Pick<CandleRow, 'tickTs' | 'poolId' | 'closeReserveBase' | 'closeReserveQuote'>;

/**
 * Deepest pool per bucket, one candle per bucket, deterministic tie-break, net flows only within
 * the same pool.
 *
 * `candleIntervalSec` lets several snapshots share one candle, which is the only way this project
 * can produce a real high and low. Sampling once per candle wrote the same price into all four
 * OHLC fields — measured 2026-09-08, 2,306 of 2,306 candles had open = high = low = close, against
 * 0.2% in trade-derived data. Fields that look usable and carry no information are worse than
 * absent ones: ATR, true range and intrabar stops all silently read zeros.
 *
 * Omit it (or pass 0) and every snapshot gets its own candle — byte-identical to the behaviour
 * before bucketing existed, which is what keeps every stored candle and every backtest valid.
 */
export function buildCandles(
  baseUnit: string,
  decimals: number,
  snapshots: SnapshotForCandle[],
  previous?: Previous,
  candleIntervalSec = 0,
): CandleRow[] {
  const bucketMs = Math.max(0, Math.trunc(candleIntervalSec)) * 1000;
  /** The candle a snapshot belongs to: its own tick when un-bucketed, else the interval floor. */
  const bucketOf = (t: Date): number => (bucketMs === 0 ? t.getTime() : Math.floor(t.getTime() / bucketMs) * bucketMs);

  const byTick = new Map<number, SnapshotForCandle[]>();
  for (const s of snapshots) {
    if (s.poolType !== 'cpmm') throw new Error(`pool_type ${String(s.poolType)} is not cpmm: ${s.poolId} @ ${s.tickTs.toISOString()}`);
    if (s.reserveBase <= 0n || s.reserveQuote <= 0n) throw new Error(`zero reserve: ${s.poolId} @ ${s.tickTs.toISOString()}`);
    if (previous && s.tickTs.getTime() <= previous.tickTs.getTime()) {
      throw new Error(`snapshot ${s.tickTs.toISOString()} is not later than previous candle ${previous.tickTs.toISOString()} (earlier or equal)`);
    }
    const k = bucketOf(s.tickTs);
    const list = byTick.get(k);
    if (list) list.push(s);
    else byTick.set(k, [s]);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  const out: CandleRow[] = [];
  let prev: Previous | undefined = previous;
  for (const k of ticks) {
    const inBucket = byTick.get(k) ?? [];
    // The candle's pool is the deepest seen in the bucket, tie-broken by pool id so the choice is
    // deterministic. Prices are then taken ONLY from that pool: mixing pools inside one candle
    // would put a different market's price in the high or low.
    const deepest = [...inBucket].sort((a, b) => {
      if (a.tvlLovelace !== b.tvlLovelace) return a.tvlLovelace > b.tvlLovelace ? -1 : 1;
      return a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0;
    })[0];
    if (!deepest) continue;
    const samePoolSamples = inBucket
      .filter((s) => s.poolId === deepest.poolId)
      .sort((a, b) => a.tickTs.getTime() - b.tickTs.getTime());
    // Extremes are chosen by comparing the SNAPSHOTS, not their formatted prices. priceAdaPerToken
    // returns an 18-place decimal STRING, and comparing those lexically is wrong ('9' > '10').
    // price = quote/base, so a/b > c/d is exactly a*d > c*b in bigint — no rounding, no parsing.
    const richer = (a: SnapshotForCandle, x: SnapshotForCandle): boolean =>
      a.reserveQuote * x.reserveBase > x.reserveQuote * a.reserveBase;
    // `last` closes the candle, not `deepest`: the close must be the newest observation in the
    // bucket, and the deepest snapshot is not necessarily the last one.
    const first = samePoolSamples[0] ?? deepest;
    const last = samePoolSamples.at(-1) ?? deepest;
    const highS = samePoolSamples.reduce((m, x) => (richer(x, m) ? x : m), first);
    const lowS = samePoolSamples.reduce((m, x) => (richer(m, x) ? x : m), first);
    const price = priceAdaPerToken(last.reserveQuote, last.reserveBase, decimals);
    const open = priceAdaPerToken(first.reserveQuote, first.reserveBase, decimals);
    const high = priceAdaPerToken(highS.reserveQuote, highS.reserveBase, decimals);
    const low = priceAdaPerToken(lowS.reserveQuote, lowS.reserveBase, decimals);
    const samePool = prev !== undefined && prev.poolId === deepest.poolId;
    const row: CandleRow = {
      baseUnit,
      // The bucket boundary when bucketing, so candles land on a regular grid the paper clock can
      // wait for; the snapshot's own tick when not, preserving the old behaviour exactly.
      tickTs: bucketMs === 0 ? last.tickTs : new Date(k),
      poolId: deepest.poolId,
      open, high, low, close: price,
      closeReserveBase: last.reserveBase,
      closeReserveQuote: last.reserveQuote,
      feeBps: last.feeBps,
      poolType: 'cpmm',
      tvlLovelace: last.tvlLovelace,
      netFlowBase: samePool && prev ? last.reserveBase - prev.closeReserveBase : null,
      netFlowQuote: samePool && prev ? last.reserveQuote - prev.closeReserveQuote : null,
    };
    out.push(row);
    prev = row;
  }
  return out;
}
