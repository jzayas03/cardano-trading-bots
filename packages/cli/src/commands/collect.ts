import { DexterPoolSource, PgSnapshotRepo, runTick, type CollectorState } from '@ctb/collector';
import { createPool } from '@ctb/db';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { msUntilNextBoundary, sleep } from '../schedule.js';

const REDISCOVER_AFTER_MS = 24 * 60 * 60 * 1000;

export async function collectCommand(log: Logger, opts: { once: boolean }): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: true });
  const universe = await loadUniverse();
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  const repo = new PgSnapshotRepo(db);
  await repo.syncTokens(universe.tokens, { seededAt: universe.seededAt, seedSource: universe.seedSource });
  const source = new DexterPoolSource({ blockfrostProjectId: cfg.blockfrostProjectId as string, log });
  const state: CollectorState = { lastDiscoveryAt: null };
  const stop = new AbortController();
  const onSignal = (sig: string) => { log.info({ sig }, 'stopping after current tick'); stop.abort(); };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  log.info({ pairs: universe.pairs.length, intervalSec: cfg.intervalSec, once: opts.once }, 'collector starting');
  try {
    do {
      const tickDeps = { source, repo, pairs: universe.pairs, log, now: () => new Date(), intervalSec: cfg.intervalSec, rediscoverAfterMs: REDISCOVER_AFTER_MS, state };
      try {
        await runTick(tickDeps);
      } catch (err) {
        // Repository failure: the run row could not be written, so log loudly and keep the loop alive.
        log.error({ err: (err as Error).message }, 'tick failed before it could be recorded');
      }
      if (opts.once || stop.signal.aborted) break;
      await sleep(msUntilNextBoundary(new Date(), cfg.intervalSec), stop.signal);
    } while (!stop.signal.aborted);
  } finally {
    await db.end();
    log.info({}, 'collector stopped');
  }
}
