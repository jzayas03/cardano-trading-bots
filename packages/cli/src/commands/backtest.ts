import { EXTERNAL_CANDLE_INTERVAL_SEC, PgCandleRepo, PgExternalRepo, type Denomination } from '@ctb/candles';
import { createPool } from '@ctb/db';
import { gitShaOrUnknown, PgRunRepo, runEngine, STRATEGIES } from '@ctb/engine';
import { SimExecutor, VENUE_COSTS, type FillModel, type VenueCosts } from '@ctb/sim-executor';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { ensureTokens } from '../ensureTokens.js';
import { externalCandleFeed, localCandleFeed } from '../feeds.js';
import { printReport } from './report.js';
import { parseGridArg } from '../grid.js';
import { compareRows, sweepRows, type SweepInput } from '../compare.js';
import { gridCombinations, gridRows, gridWarning, type GridInput } from '../grid.js';
import { parseIsoDate } from './backfill.js';

export interface BacktestArgs {
  /** One or more strategy ids (comma-separated on the command line). Each gets its own run over the same window, fill model, costs and `--param` values; more than one also prints a comparison table. */
  strategyIds: string[];
  /** A universe ticker, or `ALL`: every universe token that has data for the chosen source. */
  ticker: string; from: Date; to: Date; source: 'candles' | 'candles_external';
  /** Which `candles_external` rows to read. ADA by default; `--currency usd` for the pre-2026-09-09 dollar history. */
  denomination: Denomination;
  cashAda: number;
  /** ADA of synthetic depth (external source only); `'auto'` = each token's own latest deepest-pool ADA reserve from `pool_snapshots`. Default `'auto'` for `ALL`, required otherwise. */
  depthAda: number | 'auto' | null; batcherAda: number | null; networkAda: number | null; maxGapMin: number; params: Record<string, number>;
  /** Only meaningful with `--source external` (the synthetic fill model); defaults to `close` so every existing backtest is unchanged. */
  syntheticPrice: 'close' | 'worst';
  /** `--grid k=v1,v2` (repeatable): the Cartesian product runs once per combination, one strategy and one ticker only. */
  grid: Record<string, number[]>;
}

/** Default stale-fill bound: three 5-minute buckets. Sparse external history routinely exceeds it (finding C3). */
export const DEFAULT_MAX_GAP_MIN = 15;

const USAGE = 'usage: backtest <strategy>[,<strategy>...] <TICKER|ALL> <from-ISO> <to-ISO> [--source candles|external] [--cash-ada N] [--depth-ada N|auto] [--batcher-ada N] [--network-ada N] [--max-gap-min N] [--synthetic-price close|worst] [--param k=v]... [--grid k=v1,v2,...]...';

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

/**
 * `a,b,c` -> ['a', 'b', 'c']. An empty item (`a,,b`, a trailing comma) and a repeated id are both
 * refused rather than dropped: silently running fewer strategies than the operator typed is the
 * same defect as silently accepting a flag with no effect.
 */
export function parseStrategyList(raw: string): string[] {
  const ids = raw.split(',').map((x) => x.trim());
  if (ids.some((x) => x === '')) throw new Error(`empty strategy id in "${raw}"\n${USAGE}`);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new Error(`strategy ${dup} listed more than once\n${USAGE}`);
  return ids;
}

export function parseBacktestArgs(args: string[]): BacktestArgs {
  const [strategyArg, ticker, fromArg, toArg, ...rest] = args;
  if (!strategyArg || !ticker) throw new Error(USAGE);
  const strategyIds = parseStrategyList(strategyArg);
  const from = parseIsoDate('from', fromArg);
  const to = parseIsoDate('to', toArg);
  if (from.getTime() >= to.getTime()) throw new Error(`from must be before to\n${USAGE}`);
  const out: BacktestArgs = { strategyIds, ticker, from, to, source: 'candles', cashAda: 1000, depthAda: null, batcherAda: null, networkAda: null, maxGapMin: DEFAULT_MAX_GAP_MIN, params: {}, syntheticPrice: 'close',
    denomination: 'ada', grid: {} };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const val = rest[i + 1];
    switch (flag) {
      case '--source':
        if (val !== 'candles' && val !== 'external') throw new Error(`--source must be candles or external\n${USAGE}`);
        out.source = val === 'external' ? 'candles_external' : 'candles'; i++; break;
      case '--currency': {
        const v = args[i + 1];
        if (v !== 'ada' && v !== 'usd') throw new Error(`--currency must be ada or usd\n${USAGE}`);
        out.denomination = v; i++; break;
      }
      case '--cash-ada': out.cashAda = num(flag, val); i++; break;
      case '--depth-ada': out.depthAda = val === 'auto' ? 'auto' : num(flag, val); i++; break;
      case '--batcher-ada': out.batcherAda = num(flag, val); i++; break;
      case '--network-ada': out.networkAda = num(flag, val); i++; break;
      case '--max-gap-min': {
        const n = num(flag, val);
        if (n <= 0) throw new Error(`${flag} needs a positive number of minutes; 0 would reject every fill\n${USAGE}`);
        out.maxGapMin = n; i++; break;
      }
      case '--synthetic-price':
        if (val !== 'close' && val !== 'worst') throw new Error(`--synthetic-price must be close or worst\n${USAGE}`);
        out.syntheticPrice = val; i++; break;
      case '--grid': out.grid = parseGridArg(val, out.grid); i++; break;
      case '--param': {
        const [k, v] = splitParam(val);
        const n = Number(v);
        if (!k || v === undefined || v.trim() === '' || !Number.isFinite(n)) throw new Error(`--param needs key=numeric value, got ${val ?? '(missing)'}\n${USAGE}`);
        out.params[k] = n; i++; break;
      }
      default: throw new Error(`unknown flag ${flag}\n${USAGE}`);
    }
  }
  // A sweep over 20 tokens of very different size with one hand-typed depth would make every
  // synthetic fill meaningless for most of them, so ALL defaults to each token's own measured depth.
  if (Object.keys(out.grid).length > 0) {
    if (out.strategyIds.length > 1) throw new Error(`--grid runs one strategy; list one, not ${out.strategyIds.length}\n${USAGE}`);
    if (out.ticker === 'ALL') throw new Error(`--grid runs one ticker, not ALL\n${USAGE}`);
    const clash = Object.keys(out.grid).find((k) => k in out.params);
    if (clash) throw new Error(`${clash} is both a --param and a --grid axis; pick one\n${USAGE}`);
  }
  if (out.source === 'candles_external' && out.depthAda === null && out.ticker === 'ALL') out.depthAda = 'auto';
  if (out.source === 'candles_external' && out.depthAda === null) throw new Error(`--depth-ada is required with --source external (declared pool depth in ADA for the synthetic fill model, or auto)\n${USAGE}`);
  if (out.source === 'candles' && out.depthAda !== null) throw new Error(`--depth-ada only applies to --source external; observed reserves are used otherwise\n${USAGE}`);
  // Same footgun as depthAda: silently accepting a flag with no effect reads as "I turned on
  // worst-of pricing" when the observed fill model never looks at it.
  if (out.source === 'candles' && out.syntheticPrice !== 'close') throw new Error(`--synthetic-price only applies to --source external; observed reserves have no assumed intra-candle price\n${USAGE}`);
  return out;
}

const ada = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

/**
 * The interval a run's coverage is measured at. External history is 5-minute candles whatever the
 * collector's interval is; measuring it at the collector's 600 s counted half the expected buckets
 * and reported every external coverage figure about double (NIGHT read 101.9% on the first
 * universe sweep, 2026-09-07). Local candles are bucketed at the collector's interval.
 */
export function runIntervalSecFor(source: 'candles' | 'candles_external', collectIntervalSec: number): number {
  return source === 'candles_external' ? EXTERNAL_CANDLE_INTERVAL_SEC : collectIntervalSec;
}

/**
 * Why a sweep token is skipped, or null to run it. A pool matched on GeckoTerminal with no OHLCV
 * rows in the window (USDM on 2026-09-07: a SaturnSwap pool with no history) would otherwise run
 * every strategy over zero candles and persist three empty runs with a warning each.
 */
export function sweepSkipReason(hasMap: boolean, rowsInWindow: number): string | null {
  if (!hasMap) return 'no external history (run backfill first)';
  if (rowsInWindow === 0) return 'external history is empty in this window (the matched pool has no OHLCV rows)';
  return null;
}

/**
 * `--depth-ada auto`: the token's latest deepest pool's ADA reserve, from our own snapshots — the
 * depth the observed fill model would see today, applied to external history that carries no
 * reserves. Null when the collector has never snapshotted this token; the caller refuses rather
 * than guessing a number.
 */
export async function autoDepthLovelace(db: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> }, unit: string): Promise<bigint | null> {
  const r = await db.query<{ reserve_quote: string | null }>(
    `SELECT max(reserve_quote) AS reserve_quote FROM pool_snapshots
      WHERE base_unit = $1 AND tick_ts = (SELECT max(tick_ts) FROM pool_snapshots WHERE base_unit = $1)`,
    [unit],
  );
  const v = r.rows[0]?.reserve_quote;
  return v === null || v === undefined ? null : BigInt(v);
}

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
  costOverrides: Partial<Pick<VenueCosts, 'batcherFeeLovelace' | 'networkFeeLovelace'>>,
  maxGapMs: number,
  /** Extra provenance merged into the top-level params blob, e.g. `{ fillModelDetail: { syntheticPrice } }` for an external-source run. Omitted (as every backtest and Task 4's paper run do) leaves the blob unchanged. */
  extra?: Record<string, unknown>,
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
        basis: c.basis,
        source: c.source,
        readAt: c.readAt,
      }])),
    },
    ...extra,
  };
}

export async function backtestCommand(log: Logger, args: string[]): Promise<void> {
  const a = parseBacktestArgs(args);
  // Every id is checked before any run row is written: a typo in the third strategy must not leave
  // two finished runs behind and then fail.
  const strategies = a.strategyIds.map((id) => {
    const s = STRATEGIES[id];
    if (!s) throw new Error(`unknown strategy ${id}; known: ${Object.keys(STRATEGIES).join(', ')}`);
    return s;
  });
  const cfg = loadConfig(process.env, { blockfrost: false });
  const universe = await loadUniverse();
  const tokens = a.ticker === 'ALL' ? universe.tokens : universe.tokens.filter((t) => t.ticker === a.ticker);
  if (tokens.length === 0) throw new Error(`unknown ticker ${a.ticker}; not in universe.json`);
  const sweep = a.ticker === 'ALL';
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    await ensureTokens(db, universe);
    const runs = new PgRunRepo(db);
    const external = new PgExternalRepo(db);
    const gitSha = gitShaOrUnknown(process.cwd());
    if (gitSha === 'unknown') log.warn({}, 'git sha unknown: run provenance is incomplete');
    const maxGapMs = a.maxGapMin * 60_000;
    const costOverrides: Partial<Pick<VenueCosts, 'batcherFeeLovelace' | 'networkFeeLovelace'>> = { ...(a.batcherAda !== null ? { batcherFeeLovelace: ada(a.batcherAda) } : {}), ...(a.networkAda !== null ? { networkFeeLovelace: ada(a.networkAda) } : {}) };
    const results: SweepInput[] = [];
    const skipped: Array<{ ticker: string; reason: string }> = [];
    const combos = gridCombinations(a.grid);
    const isGrid = Object.keys(a.grid).length > 0;
    const gridResults: GridInput[] = [];
    for (const token of tokens) {
      // A sweep token with nothing to run on is a row in the skipped table, not the end of the sweep.
      if (a.source === 'candles_external' && sweep) {
        const hasMap = (await external.getMap(token.unit)) !== null;
        const rows = hasMap ? (await external.readExternal(token.unit, a.from, a.to, a.denomination)).length : 0;
        const reason = sweepSkipReason(hasMap, rows);
        if (reason) { skipped.push({ ticker: token.ticker, reason }); continue; }
      }
      let depthLovelace: bigint | null = null;
      let depthAdaForParams: number | null = null;
      if (a.source === 'candles_external') {
        if (a.depthAda === 'auto') {
          depthLovelace = await autoDepthLovelace(db, token.unit);
          if (depthLovelace === null) {
            const reason = 'no pool snapshot for this token, so --depth-ada auto has nothing to read';
            if (sweep) { skipped.push({ ticker: token.ticker, reason }); continue; }
            throw new Error(`${token.ticker}: ${reason}`);
          }
        } else {
          depthLovelace = ada(a.depthAda ?? 0);
        }
        depthAdaForParams = Number(depthLovelace) / 1_000_000;
      }
      const fillModel: FillModel = a.source === 'candles'
        ? { kind: 'cpmm_observed' }
        : { kind: 'cpmm_synthetic_depth', depthLovelace: depthLovelace ?? 0n, price: a.syntheticPrice };
      // The synthetic price mode and the depth basis only mean anything for the external source's fill
      // model; recording them for an observed-reserves run would claim choices never in effect.
      const extra = a.source === 'candles_external' ? { fillModelDetail: { syntheticPrice: a.syntheticPrice, depthBasis: a.depthAda === 'auto' ? 'auto: latest deepest-pool ADA reserve from pool_snapshots' : 'flag' } } : undefined;
      // Sequential on purpose: each run reads the same candles, and one at a time keeps the run ids
      // in the order the operator listed the strategies (and, under --grid, the combinations).
      for (const strategy of strategies) {
        for (const [gridIndex, combo] of combos.entries()) {
          const params = { ...a.params, ...combo };
          // Every run of a grid says so on its own row: a reader of one run alone must know it was one of N.
          const gridExtra = isGrid ? { grid: { size: combos.length, index: gridIndex + 1, axes: Object.keys(a.grid) } } : {};
          const runId = await runs.createRun({
            mode: 'backtest', strategyId: strategy.id, gitSha, baseUnit: token.unit, dataSource: a.source, fillModel: fillModel.kind, dataFrom: a.from, dataTo: a.to,
            params: buildRunParams(strategy.defaultParams, params, a.cashAda, depthAdaForParams, costOverrides, maxGapMs, { ...extra, ...gridExtra }),
          });
          console.log(`run id: ${runId} (${token.ticker} ${strategy.id}${isGrid ? ` ${Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''})`);
          const feed = a.source === 'candles' ? localCandleFeed(new PgCandleRepo(db), token.unit, a.from, a.to) : externalCandleFeed(external, token.unit, a.from, a.to, a.denomination);
          const executor = new SimExecutor({ decimals: token.decimals, baseUnit: token.unit, fillModel, costOverrides, maxGapMs });
          const result = await runEngine({ feed, strategy, params, executor, initial: { cashLovelace: ada(a.cashAda), positionBase: 0n }, decimals: token.decimals, log,
            intervalSec: runIntervalSecFor(a.source, cfg.intervalSec), maxGapMs });
          await runs.insertOrders(runId, token.unit, result.orders);
          await runs.finishRun(runId, new Date(), result.summary);
          const run = await runs.getRun(runId);
          if (!run) throw new Error(`run ${runId} vanished`);
          // A sweep or a grid prints one table at the end; dozens of full reports would bury it. `report <id>` has each.
          if (!sweep && !isGrid) printReport(run, await runs.listOrders(runId), token.ticker);
          results.push({ ticker: token.ticker, strategyId: strategy.id, runId, summary: result.summary, depthAda: depthAdaForParams });
          gridResults.push({ combo, runId, summary: result.summary });
        }
      }
    }
    if (isGrid) {
      const windowLabel = `${a.source} ${a.from.toISOString()} -> ${a.to.toISOString()}`;
      console.log(`\n=== grid | ${a.strategyIds[0]} | ${a.ticker} | ${windowLabel} | ${combos.length} combinations over ${Object.keys(a.grid).join(', ')}`);
      console.log(gridWarning(combos.length, windowLabel));
      console.table(gridRows(gridResults));
    }
    if (sweep) {
      console.log(`\n=== sweep | ${a.source} ${a.from.toISOString()} -> ${a.to.toISOString()} | ${results.length} runs over ${tokens.length - skipped.length} of ${tokens.length} tokens | depth: ${a.depthAda === 'auto' ? 'auto (each token\'s latest deepest-pool ADA reserve)' : `${String(a.depthAda)} ADA for every token`}`);
      console.table(sweepRows(results));
      if (skipped.length) { console.log('skipped:'); console.table(skipped); }
    } else if (!isGrid && results.length > 1) {
      console.log(`\n=== comparison | ${a.ticker} | ${a.source} ${a.from.toISOString()} -> ${a.to.toISOString()} | same fill model, costs and --param values for every row`);
      console.table(compareRows(results));
    }
  } finally {
    await db.end();
  }
}
