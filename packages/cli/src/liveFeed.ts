import { buildCandlesForToken, type CandleRepo, type CandleRow } from '@ctb/candles';
import { bucketTick, type Logger } from '@ctb/collector';
import type { Candle } from '@ctb/engine';
import type { TokenSpec } from '@ctb/universe';

export interface LiveFeedDeps {
  repo: CandleRepo;
  token: Pick<TokenSpec, 'unit' | 'decimals' | 'ticker'>;
  intervalSec: number;
  graceSec: number;
  maxGapMs: number;
  now: () => Date;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  log: Logger;
  onTick?: (info: { boundary: Date; built: number; yielded: number; skippedStale: number }) => Promise<void>;
  afterTick?: Date | null;
}

/**
 * Paper clock (spec §4.4): wait for each interval boundary plus a grace period for the collector's
 * snapshot to land, build the token's candles, and yield the new ones. A candle that is already older
 * than the stale bound when it arrives is skipped and counted, never yielded (spec §6).
 */
export async function* liveCandleFeed(d: LiveFeedDeps): AsyncIterable<Candle> {
  let lastYielded: Date | null = d.afterTick ?? null;
  while (!d.signal.aborted) {
    const now = d.now();
    const boundary = new Date(bucketTick(now, d.intervalSec).getTime() + d.intervalSec * 1000);
    const wakeAt = boundary.getTime() + d.graceSec * 1000;
    await d.sleep(Math.max(0, wakeAt - now.getTime()), d.signal);
    if (d.signal.aborted) return;
    let built = 0;
    let yielded = 0;
    let skippedStale = 0;
    try {
      built = (await buildCandlesForToken(d.repo, d.token)).built;
      const from = lastYielded ? new Date(lastYielded.getTime() + 1) : new Date(0);
      const rows = await d.repo.readCandles(d.token.unit, from, boundary);
      for (const r of rows) {
        const age = d.now().getTime() - r.tickTs.getTime();
        if (age > d.maxGapMs) {
          skippedStale++;
          d.log.warn({ tickTs: r.tickTs, ageMs: age }, 'stale candle skipped');
          lastYielded = r.tickTs; // do not re-read it next boundary
          continue;
        }
        lastYielded = r.tickTs;
        yielded++;
        yield candleFromRow(r);
      }
      if (yielded === 0 && skippedStale === 0) d.log.warn({ boundary }, 'no candle at boundary');
    } catch (err) {
      d.log.error({ boundary, err: (err as Error).message ?? String(err) }, 'live feed tick failed; continuing');
    }
    if (d.onTick) await d.onTick({ boundary, built, yielded, skippedStale });
  }
}

/**
 * A persisted `CandleRow` as the engine's `Candle`. One definition, shared by the live feed and by
 * the resume path's `primeHistory` read (finding I6), so a candle the strategy sees after a restart
 * is byte-for-byte the shape it saw before one. `volumeQuote` is null by construction: the candle
 * builder does not compute a quote volume (`candles` has no `volume` column, pinned by
 * `noVolumeColumn.guard.test.ts`).
 */
export function candleFromRow(r: CandleRow): Candle {
  return {
    tickTs: r.tickTs, open: r.open, high: r.high, low: r.low, close: r.close, volumeQuote: null,
    poolId: r.poolId, poolType: r.poolType, feeBps: r.feeBps, closeReserveBase: r.closeReserveBase,
    closeReserveQuote: r.closeReserveQuote, tvlLovelace: r.tvlLovelace,
  };
}
