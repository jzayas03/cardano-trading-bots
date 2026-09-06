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
  onTick?: (info: FeedTickInfo) => Promise<void>;
  afterTick?: Date | null;
}

/** What one boundary did. Reported on EVERY boundary, successful or not, so the caller's heartbeat
 * keeps moving and its counters and failure streak see the whole picture (findings I1a, I4, I5). */
export interface FeedTickInfo {
  boundary: Date;
  built: number;
  yielded: number;
  skippedStale: number;
  /** This boundary's build/read/report threw. */
  failed: boolean;
  /** This boundary produced no candle at all and no error — the collector has written nothing. */
  emptyBoundary: boolean;
  /** Consecutive failing boundaries INCLUDING this one; back to 0 on the first clean tick. A run
   * that is permanently broken is distinguishable from one that hit a blip only by this number. */
  consecutiveFailures: number;
  /** The message of this boundary's failure, or null on a clean tick. */
  lastError: string | null;
}

/**
 * Paper clock (spec §4.4): wait for each interval boundary plus a grace period for the collector's
 * snapshot to land, build the token's candles, and yield the new ones. A candle that is already older
 * than the stale bound when it arrives is skipped and counted, never yielded (spec §6).
 */
export async function* liveCandleFeed(d: LiveFeedDeps): AsyncIterable<Candle> {
  let lastYielded: Date | null = d.afterTick ?? null;
  let consecutiveFailures = 0;
  while (!d.signal.aborted) {
    const now = d.now();
    const boundary = new Date(bucketTick(now, d.intervalSec).getTime() + d.intervalSec * 1000);
    const wakeAt = boundary.getTime() + d.graceSec * 1000;
    await d.sleep(Math.max(0, wakeAt - now.getTime()), d.signal);
    if (d.signal.aborted) return;
    let built = 0;
    let yielded = 0;
    let skippedStale = 0;
    let emptyBoundary = false;
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
      emptyBoundary = yielded === 0 && skippedStale === 0;
      if (emptyBoundary) d.log.warn({ boundary }, 'no candle at boundary');
      // Finding I1(a): the tick report — which is where the caller writes its heartbeat — lives
      // INSIDE this try. It used to sit after the catch, so a transient failure writing the
      // heartbeat threw out of this generator, through the engine's `for await`, and ended the run.
      // A five-second Postgres blip must cost one boundary, not seven days.
      if (d.onTick) {
        await d.onTick({ boundary, built, yielded, skippedStale, failed: false, emptyBoundary, consecutiveFailures: 0, lastError: null });
      }
      consecutiveFailures = 0;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      consecutiveFailures++;
      d.log.error({ boundary, err: message, consecutiveFailures }, 'live feed tick failed; continuing');
      // The failed boundary is still reported, so the caller's heartbeat keeps moving and its
      // consecutive-failure rule (finding I5) can see the streak. The counters are deliberately
      // zeroed rather than replayed: when it is the report itself that just failed, the caller may
      // already have taken this boundary's numbers, and under-counting a diagnostic is far better
      // than double-counting one. This second call is best-effort — if the report is the broken
      // part it will fail again, and that must not throw out of the feed either.
      try {
        if (d.onTick) {
          await d.onTick({ boundary, built: 0, yielded: 0, skippedStale: 0, failed: true, emptyBoundary: false, consecutiveFailures, lastError: message });
        }
      } catch (reportErr) {
        d.log.error({ boundary, err: (reportErr as Error).message ?? String(reportErr) }, 'live feed tick report failed');
      }
    }
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
