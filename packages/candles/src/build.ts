import { priceAdaPerToken } from './price.js';
import type { CandleRow, SnapshotForCandle } from './types.js';

type Previous = Pick<CandleRow, 'tickTs' | 'poolId' | 'closeReserveBase' | 'closeReserveQuote'>;

/** Deepest pool per tick, one candle per tick, deterministic tie-break, net flows only within the same pool. */
export function buildCandles(baseUnit: string, decimals: number, snapshots: SnapshotForCandle[], previous?: Previous): CandleRow[] {
  const byTick = new Map<number, SnapshotForCandle[]>();
  for (const s of snapshots) {
    if (s.poolType !== 'cpmm') throw new Error(`pool_type ${String(s.poolType)} is not cpmm: ${s.poolId} @ ${s.tickTs.toISOString()}`);
    if (s.reserveBase <= 0n || s.reserveQuote <= 0n) throw new Error(`zero reserve: ${s.poolId} @ ${s.tickTs.toISOString()}`);
    if (previous && s.tickTs.getTime() <= previous.tickTs.getTime()) {
      throw new Error(`snapshot ${s.tickTs.toISOString()} is not later than previous candle ${previous.tickTs.toISOString()} (earlier or equal)`);
    }
    const k = s.tickTs.getTime();
    const list = byTick.get(k);
    if (list) list.push(s);
    else byTick.set(k, [s]);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  const out: CandleRow[] = [];
  let prev: Previous | undefined = previous;
  for (const k of ticks) {
    const deepest = [...(byTick.get(k) ?? [])].sort((a, b) => {
      if (a.tvlLovelace !== b.tvlLovelace) return a.tvlLovelace > b.tvlLovelace ? -1 : 1;
      return a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0;
    })[0];
    if (!deepest) continue;
    const price = priceAdaPerToken(deepest.reserveQuote, deepest.reserveBase, decimals);
    const samePool = prev !== undefined && prev.poolId === deepest.poolId;
    const row: CandleRow = {
      baseUnit,
      tickTs: deepest.tickTs,
      poolId: deepest.poolId,
      open: price, high: price, low: price, close: price,
      closeReserveBase: deepest.reserveBase,
      closeReserveQuote: deepest.reserveQuote,
      feeBps: deepest.feeBps,
      poolType: 'cpmm',
      tvlLovelace: deepest.tvlLovelace,
      netFlowBase: samePool && prev ? deepest.reserveBase - prev.closeReserveBase : null,
      netFlowQuote: samePool && prev ? deepest.reserveQuote - prev.closeReserveQuote : null,
    };
    out.push(row);
    prev = row;
  }
  return out;
}
