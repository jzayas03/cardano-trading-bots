import { PgCandleRepo, PgExternalRepo } from '@ctb/candles';
import { createPool } from '@ctb/db';
import { gitShaOrUnknown, PgRunRepo, runEngine, STRATEGIES } from '@ctb/engine';
import { SimExecutor, VENUE_COSTS, type FillModel, type VenueCosts } from '@ctb/sim-executor';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { ensureTokens } from '../ensureTokens.js';
import { externalCandleFeed, localCandleFeed } from '../feeds.js';
import { printReport } from './report.js';
import { parseIsoDate } from './backfill.js';

export interface BacktestArgs {
  strategyId: string; ticker: string; from: Date; to: Date; source: 'candles' | 'candles_external';
  cashAda: number; depthAda: number | null; batcherAda: number | null; networkAda: number | null; maxGapMin: number; params: Record<string, number>;
}

/** Default stale-fill bound: three 5-minute buckets. Sparse external history routinely exceeds it (finding C3). */
export const DEFAULT_MAX_GAP_MIN = 15;

const USAGE = 'usage: backtest <strategy> <TICKER> <from-ISO> <to-ISO> [--source candles|external] [--cash-ada N] [--depth-ada N] [--batcher-ada N] [--network-ada N] [--max-gap-min N] [--param k=v]...';

function num(flag: string, v: string | undefined): number {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative number, got ${v ?? '(missing)'}\n${USAGE}`);
  return n;
}

/**
 * Splits `key=value` on the FIRST '=' only. `'a=1=2'.split('=')` destructured to ['a', '1'], so
 * `--param a=1=2` was quietly accepted as a=1 — a typo silently changed the run rather than stopping
 * it. Anything left in the value is then rejected by the numeric check, '=' included (finding M7).
 */
function splitParam(raw: string | undefined): [string, string | undefined] {
  const s = raw ?? '';
  const i = s.indexOf('=');
  if (i <= 0) return ['', undefined];
  return [s.slice(0, i), s.slice(i + 1)];
}

export function parseBacktestArgs(args: string[]): BacktestArgs {
  const [strategyId, ticker, fromArg, toArg, ...rest] = args;
  if (!strategyId || !ticker) throw new Error(USAGE);
  const from = parseIsoDate('from', fromArg);
  const to = parseIsoDate('to', toArg);
  if (from.getTime() >= to.getTime()) throw new Error(`from must be before to\n${USAGE}`);
  const out: BacktestArgs = { strategyId, ticker, from, to, source: 'candles', cashAda: 1000, depthAda: null, batcherAda: null, networkAda: null, maxGapMin: DEFAULT_MAX_GAP_MIN, params: {} };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const val = rest[i + 1];
    switch (flag) {
      case '--source':
        if (val !== 'candles' && val !== 'external') throw new Error(`--source must be candles or external\n${USAGE}`);
        out.source = val === 'external' ? 'candles_external' : 'candles'; i++; break;
      case '--cash-ada': out.cashAda = num(flag, val); i++; break;
      case '--depth-ada': out.depthAda = num(flag, val); i++; break;
      case '--batcher-ada': out.batcherAda = num(flag, val); i++; break;
      case '--network-ada': out.networkAda = num(flag, val); i++; break;
      case '--max-gap-min': {
        const n = num(flag, val);
        if (n <= 0) throw new Error(`${flag} needs a positive number of minutes; 0 would reject every fill\n${USAGE}`);
        out.maxGapMin = n; i++; break;
      }
      case '--param': {
        const [k, v] = splitParam(val);
        const n = Number(v);
        if (!k || v === undefined || v.trim() === '' || !Number.isFinite(n)) throw new Error(`--param needs key=numeric value, got ${val ?? '(missing)'}\n${USAGE}`);
        out.params[k] = n; i++; break;
      }
      default: throw new Error(`unknown flag ${flag}\n${USAGE}`);
    }
  }
  if (out.source === 'candles_external' && out.depthAda === null) throw new Error(`--depth-ada is required with --source external (declared pool depth in ADA for the synthetic fill model)\n${USAGE}`);
  if (out.source === 'candles' && out.depthAda !== null) throw new Error(`--depth-ada only applies to --source external; observed reserves are used otherwise\n${USAGE}`);
  return out;
}

const ada = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

/**
 * Pure builder for the `runs.params` JSON blob, extracted so cost provenance can be unit-tested
 * without a database. Costs come from `@ctb/sim-executor`'s own tables, never re-hardcoded here, so
 * a change to what the executor charges is reflected in run provenance instead of drifting from it.
 */
export function buildRunParams(
  strategyDefaults: Record<string, number>,
  argParams: Record<string, number>,
  cashAda: number,
  depthAda: number | null,
  costOverrides: Partial<VenueCosts>,
  maxGapMs: number,
): Record<string, unknown> {
  const params = { ...strategyDefaults, ...argParams };
  return {
    ...params,
    cashAda,
    depthAda,
    // The stale-fill bound is part of the fill model, so it belongs in the run's provenance: two runs
    // over the same window with different bounds are not comparable (finding C3).
    maxGapMs,
    // Finding I1: this used to record ONE flat batcher/network pair, which is not what the executor
    // charges — it charges per venue, from VENUE_COSTS, with the run's overrides applied on top.
    // Both halves are recorded: `venues` is the table as it stood for this run, `overrides` is what
    // the operator changed, and an override wins over the table for every venue.
    costs: {
      overrides: {
        ...(costOverrides.batcherFeeLovelace !== undefined ? { batcherFeeLovelace: costOverrides.batcherFeeLovelace.toString() } : {}),
        ...(costOverrides.networkFeeLovelace !== undefined ? { networkFeeLovelace: costOverrides.networkFeeLovelace.toString() } : {}),
      },
      venues: Object.fromEntries(Object.entries(VENUE_COSTS).map(([venue, c]) => [venue, {
        batcherFeeLovelace: c.batcherFeeLovelace.toString(),
        networkFeeLovelace: c.networkFeeLovelace.toString(),
      }])),
    },
  };
}

export async function backtestCommand(log: Logger, args: string[]): Promise<void> {
  const a = parseBacktestArgs(args);
  const strategy = STRATEGIES[a.strategyId];
  if (!strategy) throw new Error(`unknown strategy ${a.strategyId}; known: ${Object.keys(STRATEGIES).join(', ')}`);
  const cfg = loadConfig(process.env, { blockfrost: false });
  const universe = await loadUniverse();
  const token = universe.tokens.find((t) => t.ticker === a.ticker);
  if (!token) throw new Error(`unknown ticker ${a.ticker}; not in universe.json`);
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    await ensureTokens(db, universe);
    const runs = new PgRunRepo(db);
    const gitSha = gitShaOrUnknown(process.cwd());
    if (gitSha === 'unknown') log.warn({}, 'git sha unknown: run provenance is incomplete');
    const fillModel: FillModel = a.source === 'candles' ? { kind: 'cpmm_observed' } : { kind: 'cpmm_synthetic_depth', depthLovelace: ada(a.depthAda ?? 0) };
    const maxGapMs = a.maxGapMin * 60_000;
    const costOverrides: Partial<VenueCosts> = { ...(a.batcherAda !== null ? { batcherFeeLovelace: ada(a.batcherAda) } : {}), ...(a.networkAda !== null ? { networkFeeLovelace: ada(a.networkAda) } : {}) };
    const runId = await runs.createRun({
      mode: 'backtest', strategyId: strategy.id, gitSha, baseUnit: token.unit, dataSource: a.source, fillModel: fillModel.kind, dataFrom: a.from, dataTo: a.to,
      params: buildRunParams(strategy.defaultParams, a.params, a.cashAda, a.depthAda, costOverrides, maxGapMs),
    });
    console.log(`run id: ${runId}`);
    const feed = a.source === 'candles' ? localCandleFeed(new PgCandleRepo(db), token.unit, a.from, a.to) : externalCandleFeed(new PgExternalRepo(db), token.unit, a.from, a.to);
    const executor = new SimExecutor({ decimals: token.decimals, baseUnit: token.unit, fillModel, costOverrides, maxGapMs });
    const result = await runEngine({ feed, strategy, params: a.params, executor, initial: { cashLovelace: ada(a.cashAda), positionBase: 0n }, decimals: token.decimals, log,
      intervalSec: cfg.intervalSec, maxGapMs });
    await runs.insertOrders(runId, token.unit, result.orders);
    await runs.finishRun(runId, new Date(), result.summary);
    const run = await runs.getRun(runId);
    if (!run) throw new Error(`run ${runId} vanished`);
    printReport(run, await runs.listOrders(runId), token.ticker);
  } finally {
    await db.end();
  }
}
