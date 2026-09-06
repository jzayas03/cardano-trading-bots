import { bucketTick, PgSnapshotRepo, type SnapshotRow } from '@ctb/collector';
import { createPool, type Db } from '@ctb/db';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { ensureTokens } from '../ensureTokens.js';
import { assertFakeAllowed, fakeWalkStep, mulberry32, type Reserves } from '../fakeWalk.js';
import { sleep } from '../schedule.js';

export interface FakeCollectorArgs {
  ticker: string;
  intervalSec: number;
  seed: number;
  once: boolean;
}

const USAGE = 'usage: dev:fake-collector <TICKER> [--interval-sec 60] [--seed 42] [--once]';

/** Genesis reserves for a token this tool has never touched before: 20M base units (scaled by the
 * token's own decimals) against 50 000 ADA — an arbitrary but stable starting depth, chosen once so
 * every fresh rehearsal for a given ticker starts from the same place. */
const SEED_RESERVE_BASE_WHOLE = 20_000_000n;
const SEED_RESERVE_QUOTE_ADA = 50_000n;
const LOVELACE_PER_ADA = 1_000_000n;
const FAKE_DEX = 'Fake';
const FAKE_FEE_BPS = 30;

export function parseFakeCollectorArgs(args: string[]): FakeCollectorArgs {
  const [ticker, ...rest] = args;
  if (!ticker) throw new Error(USAGE);
  const out: FakeCollectorArgs = { ticker, intervalSec: 60, seed: 42, once: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const val = rest[i + 1];
    switch (flag) {
      case '--interval-sec': {
        const n = Number(val);
        if (val === undefined || !Number.isFinite(n) || n < 1) throw new Error(`--interval-sec needs a positive number of seconds\n${USAGE}`);
        out.intervalSec = n;
        i++;
        break;
      }
      case '--seed': {
        const n = Number(val);
        if (val === undefined || !Number.isInteger(n)) throw new Error(`--seed needs an integer\n${USAGE}`);
        out.seed = n;
        i++;
        break;
      }
      case '--once':
        out.once = true;
        break;
      default:
        throw new Error(`unknown flag ${flag}\n${USAGE}`);
    }
  }
  return out;
}

/**
 * The reserves of the most recent `Fake:<ticker>` snapshot, or null when none exists yet. Reading
 * this back at startup — rather than always restarting from the seed reserves — is what lets a
 * killed-and-restarted `dev:fake-collector` continue the same rehearsal pool instead of teleporting
 * its reserves back to genesis mid-run.
 */
async function lastFakeReserves(db: Db, poolId: string): Promise<Reserves | null> {
  const res = await db.query<{ reserve_base: string; reserve_quote: string }>(
    'SELECT reserve_base, reserve_quote FROM pool_snapshots WHERE pool_id = $1 ORDER BY tick_ts DESC LIMIT 1',
    [poolId],
  );
  const r = res.rows[0];
  return r ? { reserveBase: BigInt(r.reserve_base), reserveQuote: BigInt(r.reserve_quote) } : null;
}

/**
 * Rehearsal tool (Plan 3 Task 6): writes one synthetic `Fake:<TICKER>` pool snapshot per interval
 * boundary, walked forward with `fakeWalkStep` so `paper --rehearsal` has something CPMM-shaped to
 * fill against without a live collector or a Blockfrost key. `assertFakeAllowed` is checked before
 * any other work — synthetic data can never be mistaken for real (global constraint), so refusing
 * has to happen before this tool touches the database at all, not after ensureTokens/etc.
 */
export async function devFakeCollectorCommand(log: Logger, args: string[]): Promise<void> {
  const a = parseFakeCollectorArgs(args);
  const cfg = loadConfig(process.env, { blockfrost: false });
  assertFakeAllowed(process.env, cfg.databaseUrl);
  const universe = await loadUniverse();
  const token = universe.tokens.find((t) => t.ticker === a.ticker);
  if (!token) throw new Error(`unknown ticker ${a.ticker}; not in universe.json`);
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  const repo = new PgSnapshotRepo(db);
  const poolId = `${FAKE_DEX}:${a.ticker}`;
  const rng = mulberry32(a.seed);
  const stop = new AbortController();
  const onSignal = (sig: string): void => {
    log.info({ sig }, 'stopping after current tick');
    stop.abort();
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    await ensureTokens(db, universe);
    let current = (await lastFakeReserves(db, poolId)) ?? {
      reserveBase: SEED_RESERVE_BASE_WHOLE * 10n ** BigInt(token.decimals),
      reserveQuote: SEED_RESERVE_QUOTE_ADA * LOVELACE_PER_ADA,
    };
    log.info({ ticker: a.ticker, intervalSec: a.intervalSec, seed: a.seed, once: a.once, poolId }, 'dev:fake-collector starting');
    let pendingTickTs: Date | undefined;
    do {
      const startedAt = new Date();
      const tickTs = pendingTickTs ?? startedAt;
      current = fakeWalkStep(rng, current);
      const runId = await repo.startRun(tickTs, startedAt);
      const row: SnapshotRow = {
        tickTs,
        dex: FAKE_DEX,
        poolId,
        poolAddress: 'fake',
        baseUnit: token.unit,
        quoteUnit: 'lovelace',
        reserveBase: current.reserveBase,
        reserveQuote: current.reserveQuote,
        feeBps: FAKE_FEE_BPS,
        poolType: 'cpmm',
        tvlLovelace: 2n * current.reserveQuote,
        blockHeight: 0,
        observedAt: startedAt,
      };
      const written = await repo.insertSnapshots(runId, [row]);
      await repo.finishRun(runId, new Date(), {
        poolsAttempted: 1,
        poolsFailed: 0,
        poolsWritten: written,
        providerCalls: 0,
        discovered: false,
        discoveryCalls: null,
        errors: [{ scope: 'fake', message: 'synthetic snapshot from dev:fake-collector' }],
      });
      log.info(
        { tick: tickTs.toISOString(), reserveBase: current.reserveBase.toString(), reserveQuote: current.reserveQuote.toString() },
        'fake snapshot written',
      );
      if (a.once || stop.signal.aborted) break;
      // Same boundary-sleep shape as `collect.ts`: the next tick's bucket is computed BEFORE
      // sleeping and passed back in, so an early wake never re-derives a bucket from `now()` that
      // lands one interval earlier than the boundary actually slept for.
      const next = new Date(bucketTick(new Date(), a.intervalSec).getTime() + a.intervalSec * 1000);
      await sleep(next.getTime() - Date.now(), stop.signal);
      pendingTickTs = next;
    } while (!stop.signal.aborted);
  } finally {
    await db.end();
    log.info({}, 'dev:fake-collector stopped');
  }
}
