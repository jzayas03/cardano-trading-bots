import { bucketTick, DexterPoolSource, PgSnapshotRepo, runTick, utcDay, type CollectorState } from '@ctb/collector';
import { createPool } from '@ctb/db';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { ensureTokens } from '../ensureTokens.js';
import { sleep } from '../schedule.js';

const REDISCOVER_AFTER_MS = 24 * 60 * 60 * 1000;

export async function collectCommand(log: Logger, opts: { once: boolean }): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: true });
  const universe = await loadUniverse();
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  const repo = new PgSnapshotRepo(db);
  await ensureTokens(db, universe);
  // Finding I7: `retryBudgetMs` existed on DexterPoolSource and nothing ever set it, so every
  // deployment silently ran the built-in 60 s — longer than a 60 s collector interval would allow,
  // and unrelated to whatever interval is configured. Half the tick is the bound that makes sense:
  // retries that outlive their own tick only delay the next one.
  const source = new DexterPoolSource({
    blockfrostProjectId: cfg.blockfrostProjectId as string, log, retryBudgetMs: cfg.intervalSec * 500, venues: cfg.venues,
    refreshPolicy: cfg.refreshPolicy, minDepthLovelace: cfg.minDepthLovelace,
  });
  // THE RESTART FIX. Both of these facts were already in the database and neither was read, so every
  // process start looked to `runTick` like a universe that had never been discovered: `lastDiscoveryAt`
  // null AND `knownPoolCount()` zero. Either alone forces a full sweep.
  //
  // Measured 2026-09-08: five collector restarts bought five sweeps -- 25,174 of the day's 43,469
  // Blockfrost calls -- and the free tier ran out at 20:15 UTC, after which every tick failed closed
  // on a 402 at `/blocks/latest` and the three paper runs sat on a dead feed. A restart now costs a
  // normal refresh (~300 calls) instead of ~5,700.
  const restart = await repo.restartState(new Date());
  const hydrated = source.hydrate(restart.pools);
  const state: CollectorState = {
    lastDiscoveryAt: restart.lastDiscoveryAt,
    callsSpentToday: restart.callsSpentToday,
    spendDay: utcDay(new Date()),
    lastDiscoveryCost: restart.lastDiscoveryCost,
  };
  log.info(
    { hydratedPools: hydrated, lastDiscoveryAt: restart.lastDiscoveryAt, callsSpentToday: restart.callsSpentToday,
      lastDiscoveryCost: restart.lastDiscoveryCost, dailyCallCeiling: cfg.dailyCallCeiling },
    hydrated > 0 ? 'warm start: pool set restored, no discovery sweep needed' : 'cold start: no pool cache, the first tick will discover',
  );
  const stop = new AbortController();
  const onSignal = (sig: string) => { log.info({ sig }, 'stopping after current tick'); stop.abort(); };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  log.info(
    { pairs: universe.pairs.length, intervalSec: cfg.intervalSec, once: opts.once, venues: cfg.venues, refreshPolicy: cfg.refreshPolicy,
      minDepthAda: Number(cfg.minDepthLovelace) / 1_000_000, focusTicker: cfg.focusTicker, focusIntervalSec: cfg.focusIntervalSec },
    'collector starting',
  );

  // Tiered sampling. The loop runs at the FOCUS interval and refreshes only the focus token, except
  // every Nth tick where it refreshes everything — so the traded token gets N samples per candle
  // (a real high and low) while the rest stay fresh enough for the screener, inside one budget.
  //
  //   ~15 calls per pool per tick: 1 token at 60s = 21,600/day, 19 at 3600s = 6,840, discovery
  //   5,692. About 34,100 against the ~34,200 a flat 900s across 20 tokens already costs.
  const focusUnit = cfg.focusTicker
    ? universe.pairs.find((p) => p.base.ticker === cfg.focusTicker)?.base.unit ?? null
    : null;
  if (cfg.focusTicker && !focusUnit) {
    // Fail closed: a typo here would silently collect nothing at the fine interval and look healthy.
    throw new Error(`COLLECT_FOCUS_TICKER=${cfg.focusTicker} is not in the universe`);
  }
  const tiered = focusUnit !== null && cfg.focusIntervalSec > 0;
  const loopSec = tiered ? cfg.focusIntervalSec : cfg.intervalSec;
  const ticksPerCandle = tiered ? cfg.intervalSec / cfg.focusIntervalSec : 1;
  const focusOnly = focusUnit ? new Set([focusUnit]) : undefined;
  if (tiered) {
    log.info({ focusTicker: cfg.focusTicker, loopSec, ticksPerCandle }, 'tiered sampling: focus token every tick, all tokens every Nth');
  }
  let tickIndex = 0;
  // The immediate first tick has no boundary to pin to, so it still derives tickTs from now().
  // Every tick after that writes the exact boundary the loop slept toward (computed below, BEFORE
  // sleeping) instead of re-deriving one from now() on wake — an early wake re-derived from now()
  // can bucket one interval EARLIER than the boundary actually slept for (finding F7).
  let pendingTickTs: Date | undefined;
  try {
    do {
      // Every Nth tick is a full refresh; the rest touch only the focus token. Tick 0 is full, so a
      // fresh start always has every pool before any partial tick runs.
      const fullTick = !tiered || tickIndex % ticksPerCandle === 0;
      const tickDeps = {
        source, repo, pairs: universe.pairs, log, now: () => new Date(),
        // The snapshot's own bucket is the LOOP interval, so several samples land inside one candle
        // at distinct tick_ts instead of colliding on the primary key.
        intervalSec: loopSec,
        rediscoverAfterMs: REDISCOVER_AFTER_MS, state, tickTs: pendingTickTs,
        dailyCallCeiling: cfg.dailyCallCeiling, poolCache: repo,
        refreshOnly: fullTick ? undefined : focusOnly,
      };
      try {
        await runTick(tickDeps);
      } catch (err) {
        // Repository failure: the run row could not be written, so log loudly and keep the loop alive.
        log.error({ err: (err as Error).message }, 'tick failed before it could be recorded');
      }
      if (opts.once || stop.signal.aborted) break;
      const beforeSleep = new Date();
      const next = new Date(bucketTick(beforeSleep, loopSec).getTime() + loopSec * 1000);
      await sleep(next.getTime() - beforeSleep.getTime(), stop.signal);
      pendingTickTs = next;
      tickIndex += 1;
    } while (!stop.signal.aborted);
  } finally {
    await db.end();
    log.info({}, 'collector stopped');
  }
}
