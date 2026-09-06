import { PgCandleRepo } from '@ctb/candles';
import { createPool } from '@ctb/db';
import { gitShaOrUnknown, PgRunRepo, runEngine, STRATEGIES, type Portfolio } from '@ctb/engine';
import { SimExecutor } from '@ctb/sim-executor';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { ensureTokens } from '../ensureTokens.js';
import { liveCandleFeed } from '../liveFeed.js';
import { sleep } from '../schedule.js';
import { buildRunParams } from './backtest.js';
import { printReport } from './report.js';

export interface PaperArgs {
  strategyId: string; ticker: string; cashAda: number; resume: number | null; intervalSec: number;
  graceSec: number; maxGapMin: number; rehearsal: boolean; params: Record<string, number>;
}

const USAGE = 'usage: paper <strategy> <TICKER> [--cash-ada N] [--resume RUN_ID] [--interval-sec 300] [--grace-sec 60] [--max-gap-min 15] [--rehearsal] [--param k=v]...';
const ada = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

export function parsePaperArgs(args: string[]): PaperArgs {
  const [strategyId, ticker, ...rest] = args;
  if (!strategyId || !ticker) throw new Error(USAGE);
  const out: PaperArgs = {
    strategyId, ticker, cashAda: 1000, resume: null, intervalSec: 300, graceSec: 60, maxGapMin: 15, rehearsal: false, params: {},
  };
  const num = (flag: string, v: string | undefined, min: number): number => {
    const n = Number(v);
    if (v === undefined || v.trim() === '' || !Number.isFinite(n) || n < min) throw new Error(`${flag} needs a number >= ${min}\n${USAGE}`);
    return n;
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const val = rest[i + 1];
    switch (flag) {
      case '--cash-ada': out.cashAda = num(flag, val, 0); i++; break;
      case '--resume': out.resume = num(flag, val, 1); i++; break;
      case '--interval-sec': out.intervalSec = num(flag, val, 60); i++; break;
      case '--grace-sec': out.graceSec = num(flag, val, 0); i++; break;
      case '--max-gap-min': out.maxGapMin = num(flag, val, 1); i++; break;
      case '--rehearsal': out.rehearsal = true; break;
      case '--param': {
        const eq = (val ?? '').indexOf('=');
        const k = eq > 0 ? val!.slice(0, eq) : '';
        const v = eq > 0 ? val!.slice(eq + 1) : '';
        const n = Number(v);
        if (!k || v.trim() === '' || v.includes('=') || !Number.isFinite(n)) throw new Error(`--param needs key=numeric value\n${USAGE}`);
        out.params[k] = n;
        i++;
        break;
      }
      default: throw new Error(`unknown flag ${flag}\n${USAGE}`);
    }
  }
  return out;
}

export async function paperCommand(log: Logger, args: string[]): Promise<void> {
  const a = parsePaperArgs(args);
  const strategy = STRATEGIES[a.strategyId];
  if (!strategy) throw new Error(`unknown strategy ${a.strategyId}; known: ${Object.keys(STRATEGIES).join(', ')}`);
  if (a.rehearsal && process.env.CTB_ALLOW_FAKE_DATA !== '1') throw new Error('rehearsal requires CTB_ALLOW_FAKE_DATA=1');
  const cfg = loadConfig(process.env, { blockfrost: false });
  const universe = await loadUniverse();
  const token = universe.tokens.find((t) => t.ticker === a.ticker);
  if (!token) throw new Error(`unknown ticker ${a.ticker}; not in universe.json`);
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  const ac = new AbortController();
  const onSignal = (sig: string): void => { log.info({ sig }, 'stopping after the current candle'); ac.abort(); };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  let runId: number | null = null;
  const runs = new PgRunRepo(db);
  try {
    await ensureTokens(db, universe);
    if (!a.rehearsal) {
      // Synthetic data can never be mistaken for real: a Fake-dex snapshot in the last 24h for this
      // token means a rehearsal run touched this database and never cleaned up after itself.
      const fake = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM pool_snapshots WHERE base_unit = $1 AND dex = 'Fake' AND tick_ts > now() - interval '24 hours'`,
        [token.unit],
      );
      if (Number(fake.rows[0]?.n ?? 0) > 0) throw new Error('rehearsal data present for this token; pass --rehearsal or clean the database');
    }
    const maxGapMs = a.maxGapMin * 60_000;
    let initial: Portfolio = { cashLovelace: ada(a.cashAda), positionBase: 0n };
    let startSeq = 0;
    let afterTick: Date | null = null;
    if (a.resume !== null) {
      const prior = await runs.getRun(a.resume);
      if (!prior || prior.mode !== 'paper') throw new Error(`run ${a.resume} is not a paper run`);
      if (prior.strategyId !== strategy.id || prior.baseUnit !== token.unit) {
        throw new Error(`run ${a.resume} is ${prior.strategyId}/${prior.baseUnit}, not ${strategy.id}/${token.unit}`);
      }
      if (prior.status === 'finished') throw new Error(`run ${a.resume} is finished; start a new run`);
      const last = await runs.lastEquity(a.resume);
      if (last) { initial = { cashLovelace: last.cashLovelace, positionBase: last.positionBase }; afterTick = last.tickTs; }
      startSeq = await runs.lastOrderSeq(a.resume);
      runId = a.resume;
      await runs.appendResume(runId, new Date());
      await runs.setStatus(runId, 'running', null);
      log.info({ runId, afterTick, startSeq }, 'resumed run; intents pending at the previous stop were lost');
    } else {
      const gitSha = gitShaOrUnknown(process.cwd());
      runId = await runs.createRun({
        mode: 'paper', strategyId: strategy.id, gitSha, baseUnit: token.unit, dataSource: 'candles', fillModel: 'cpmm_observed',
        dataFrom: new Date(), dataTo: new Date(),
        params: { ...buildRunParams(strategy.defaultParams, a.params, a.cashAda, null, {}, maxGapMs), intervalSec: a.intervalSec, graceSec: a.graceSec, rehearsal: a.rehearsal },
        status: 'running', rehearsal: a.rehearsal,
      });
    }
    console.log(`run id: ${runId}${a.rehearsal ? ' (REHEARSAL)' : ''}`);
    const id = runId;
    const candleRepo = new PgCandleRepo(db);
    const executor = new SimExecutor({ decimals: token.decimals, baseUnit: token.unit, fillModel: { kind: 'cpmm_observed' }, maxGapMs });
    const feed = liveCandleFeed({
      repo: candleRepo, token, intervalSec: a.intervalSec, graceSec: a.graceSec, maxGapMs, now: () => new Date(), sleep, signal: ac.signal, log, afterTick,
      onTick: async () => { await runs.heartbeat(id, new Date(), null); },
    });
    const result = await runEngine({
      feed, strategy, params: a.params, executor, initial, decimals: token.decimals, log, retain: false, startSeq, signal: ac.signal,
      intervalSec: a.intervalSec, maxGapMs,
      sinks: {
        onOrder: async (o) => { await runs.insertOrders(id, token.unit, [o]); },
        onEquity: async (e) => { await runs.insertEquity(id, [e]); },
        onCandle: async (c) => { await runs.heartbeat(id, new Date(), c.tickTs); },
      },
    });
    await runs.finishRun(id, new Date(), result.summary);
    await runs.setStatus(id, 'finished', ac.signal.aborted ? 'signal' : 'feed ended');
    const run = await runs.getRun(id);
    if (run) {
      if (a.rehearsal) console.log('REHEARSAL');
      printReport(run, await runs.listOrders(id), token.ticker);
    }
  } catch (err) {
    if (runId !== null) {
      await runs.setStatus(runId, 'aborted', (err as Error).message ?? String(err)).catch(() => {
        // intentional: original error wins; a failure recording the abort must not replace the real one
      });
    }
    throw err;
  } finally {
    await db.end();
  }
}
