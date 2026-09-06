import { createPool } from '@ctb/db';
import { PgRunRepo, type EquityPoint, type OrderRecord, type RunCoverage, type RunRow } from '@ctb/engine';
import { assumedVenuesTouched } from '@ctb/sim-executor';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

const USAGE = 'usage: report <run-id> [--day YYYY-MM-DD]';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `--day` reads only `listEquity`/`listOrdersBetween` scoped to one UTC day (global constraint: no
 * other query paths for the day report). `to` is the last millisecond of that day so a `BETWEEN`
 * query is inclusive of every tick on the day and exclusive of the next day's first tick.
 */
export function dayWindow(day: string): { from: Date; to: Date } {
  if (!DAY_RE.test(day)) throw new Error(`--day must be YYYY-MM-DD (zero-padded), got ${JSON.stringify(day)}`);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const from = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls an out-of-range day/month forward (e.g. Feb 30 -> Mar 2) instead of rejecting it;
  // round-tripping the parts back out of the constructed date catches that silent rollover.
  if (from.getUTCFullYear() !== y || from.getUTCMonth() !== m - 1 || from.getUTCDate() !== d) {
    throw new Error(`--day is not a real calendar date: ${day}`);
  }
  return { from, to: new Date(from.getTime() + 86_400_000 - 1) };
}

export interface DaySummary {
  points: number;
  startEquity: bigint | null; endEquity: bigint | null;
  startExecutable: bigint | null; endExecutable: bigint | null;
  returnPct: number | null;
  filled: number; rejected: number; rejectReasons: Record<string, number>; staleRejects: number;
  feesLovelace: bigint; poolFeesIn: bigint;
}

/**
 * Pure: the day's equity points and orders in, a summary out. `returnPct` is computed from the
 * first and last equity point of the day in basis points via bigint (never a float division on
 * lovelace amounts), and is null when there are fewer than two points or the start equity is 0 —
 * there is no return to report over zero or one point. `staleRejects` is the `stale t+1` sub-count
 * called out separately in the reject-reasons table (spec: a stale pair does not trade).
 */
export function summarizeDay(equity: EquityPoint[], orders: OrderRecord[]): DaySummary {
  const first = equity[0] ?? null;
  const last = equity.length > 0 ? equity[equity.length - 1]! : null;
  const startEquity = first ? first.equityLovelace : null;
  const endEquity = last ? last.equityLovelace : null;
  const returnPct =
    equity.length >= 2 && startEquity !== null && startEquity !== 0n && endEquity !== null
      ? Number(((endEquity - startEquity) * 10_000n) / startEquity) / 100
      : null;

  let filled = 0;
  let rejected = 0;
  let staleRejects = 0;
  let feesLovelace = 0n;
  let poolFeesIn = 0n;
  const rejectReasons: Record<string, number> = {};
  for (const o of orders) {
    if (o.result.status === 'filled') {
      filled++;
      feesLovelace += o.result.batcherFeeLovelace + o.result.networkFeeLovelace;
      poolFeesIn += o.result.poolFeeIn;
    } else {
      rejected++;
      rejectReasons[o.result.reason] = (rejectReasons[o.result.reason] ?? 0) + 1;
      if (o.result.reason.startsWith('stale t+1')) staleRejects++;
    }
  }
  return {
    points: equity.length,
    startEquity, endEquity,
    startExecutable: first ? first.equityExecutableLovelace : null,
    endExecutable: last ? last.equityExecutableLovelace : null,
    returnPct, filled, rejected, rejectReasons, staleRejects, feesLovelace, poolFeesIn,
  };
}

/**
 * The same pure computation as `summarizeDay`, named for its other use: the whole-run headline a
 * paper report prints from its PERSISTED rows. Final-review finding C1 — after a resume,
 * `runs.summary` describes only the segment whose process wrote it (`finishRun` overwrites the
 * column wholesale, and that process's `Summarizer` only ever saw its own candles). Verified on
 * rehearsal run 6: `summary` said 1 intent / 1 filled / 12 candles while `paper_orders` held 2 rows
 * and `run_equity` held 27. Equity points and orders in, one summary out — an alias rather than a
 * copy so the day view and the run headline can never drift apart.
 */
export const summarizeRun = summarizeDay;

/**
 * Lovelace to ADA with six decimals, in bigint. `Number(BigInt(x)) / 1e6` loses precision above
 * 2^53 lovelace (~9.007 billion ADA) and, more to the point, prints an approximation of a number the
 * whole report exists to make exact (finding M10).
 */
export const adaStr = (lovelace: string | bigint): string => {
  const v = BigInt(lovelace);
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? '-' : ''}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, '0')}`;
};

/**
 * Coverage belongs in the header, next to the provenance: a return figure computed over 4400 sparse
 * candles in a window that should hold 26 000 is not the same claim as one computed over a full
 * window, and nothing else on the report says which one it is (finding C3).
 */
export function coverageLine(c: RunCoverage | undefined): string {
  if (!c) return 'coverage: not recorded (run predates coverage stats)';
  const pct = c.expectedBuckets > 0 ? ((c.candles / c.expectedBuckets) * 100).toFixed(1) : '0.0';
  const range = c.first && c.last ? `${c.first} -> ${c.last}` : 'empty window';
  return `coverage: ${c.candles} of ${c.expectedBuckets} expected buckets (${pct}%) | ${range} | max gap ${Math.round(c.maxGapMs / 60_000)}m | ${c.gapsOverBound} gaps over the stale-fill bound`;
}

/**
 * Operator output. Every number here comes from the runs row and its orders; the header is the
 * provenance. Synthetic data can never be mistaken for real (global constraint): the REHEARSAL
 * warning comes from `run.rehearsal`, the persisted row, so it prints on every path that reads this
 * run back — the process that created it AND a later `report <run-id>` — not just the one that
 * happened to set an ad-hoc console line at the end of its own process (finding F3).
 */
export function printReport(
  run: RunRow, orders: Array<OrderRecord & { baseUnit: string }>, ticker: string, persistedEquity: EquityPoint[] = [],
): void {
  if (run.rehearsal) console.log('REHEARSAL — synthetic data — not evidence');
  console.log(`\n=== run ${run.id} | ${run.mode} | ${run.strategyId} | ${ticker} | git ${run.gitSha}`);
  console.log(`data: ${run.dataSource} ${run.dataFrom.toISOString()} -> ${run.dataTo.toISOString()} | fill model: ${run.fillModel}`);
  console.log(`params: ${JSON.stringify(run.params)}`);
  if (run.mode === 'paper') {
    printPaperStatusLines(run);
    printPersistedHeadline(run, persistedEquity, orders);
  }
  if (!run.summary) { console.log('run has no summary (unfinished)'); return; }
  const s = run.summary;
  console.log(coverageLine(s.coverage));
  for (const w of s.warnings ?? []) console.log(`warning: ${w}`);
  console.table([{ candles: s.candles, intents: s.intents, filled: s.filled, rejected: s.rejected, startAda: adaStr(s.startEquityLovelace), endAda: adaStr(s.endEquityLovelace),
    returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct, lovelaceFeesAda: adaStr(s.feesLovelace), poolFeesIn: s.poolFeesIn }]);
  const assumed = assumedVenuesTouched(orders);
  if (assumed.length) console.log(`warning: fills touched venues with ASSUMED costs: ${assumed.join(', ')} (see runs.params.costs.venues)`);
  if (Object.keys(s.rejectReasons).length) console.table(Object.entries(s.rejectReasons).map(([reason, count]) => ({ reason, count })));
  console.table(orders.slice(0, 50).map((o) => ({
    seq: o.seq, intent: o.tsIntent.toISOString(), side: o.intent.side, amountIn: o.intent.amountIn.toString(), status: o.result.status,
    fill: o.result.status === 'filled' ? o.result.tsFill.toISOString() : '-', amountOut: o.result.status === 'filled' ? o.result.amountOut.toString() : '-',
    slippageBps: o.result.status === 'filled' ? o.result.slippageBps : '-',
    priceImpactBps: o.result.status === 'filled' ? o.result.priceImpactBps : '-', reason: o.result.status === 'rejected' ? o.result.reason : o.intent.reason,
  })));
  if (orders.length > 50) console.log(`... ${orders.length - 50} more orders (query paper_orders where run_id = ${run.id})`);
}

/** The ISO timestamps `RunRepo.appendResume` has appended to `params.resumes`, or [] on a run that
 * predates the column or has never been resumed. Read as `unknown[]` and stringified per element —
 * this is a jsonb blob, not a typed column. */
function resumesOf(run: RunRow): string[] {
  const raw = run.params.resumes;
  return Array.isArray(raw) ? raw.map((x) => String(x)) : [];
}

/**
 * Finding C1. `runs.summary` is written by `finishRun` at the end of ONE process's segment, from a
 * `Summarizer` that only ever ingested that segment's own candles — so on a resumed run it silently
 * describes the last segment while presenting itself as the run's numbers (rehearsal run 6: summary
 * said 1 intent / 1 filled / 12 candles over `paper_orders` holding 2 and `run_equity` holding 27).
 * The headline an operator reads first is therefore recomputed here from the PERSISTED rows — every
 * equity point and every order the run has ever written, across every segment — and the stored
 * summary is kept below it, explicitly labelled as the last segment only, next to the resume count
 * that says how many segments it is missing.
 */
function printPersistedHeadline(run: RunRow, equity: EquityPoint[], orders: Array<OrderRecord & { baseUnit: string }>): void {
  const s = summarizeRun(equity, orders);
  console.log('summary (from persisted rows) — run_equity + paper_orders, every segment:');
  console.table([{
    points: s.points,
    startAda: s.startEquity !== null ? adaStr(s.startEquity) : '-',
    endAda: s.endEquity !== null ? adaStr(s.endEquity) : '-',
    startExecAda: s.startExecutable !== null ? adaStr(s.startExecutable) : '-',
    endExecAda: s.endExecutable !== null ? adaStr(s.endExecutable) : '-',
    returnPct: s.returnPct ?? '-',
    filled: s.filled, rejected: s.rejected, staleRejects: s.staleRejects,
    feesAda: adaStr(s.feesLovelace), poolFeesIn: s.poolFeesIn.toString(),
  }]);
  const resumes = resumesOf(run);
  console.log(
    `last segment summary (runs.summary — the segment that last wrote it, NOT the whole run; resumes: ${resumes.length}):`,
  );
}

/**
 * A paper run is a long-lived process an operator checks in on mid-flight — `run has no summary
 * (unfinished)` above is not enough to tell whether it is healthy. `resumes` comes from
 * `params.resumes`, the ISO-timestamp array `RunRepo.appendResume` grows on every restart.
 */
function printPaperStatusLines(run: RunRow): void {
  console.log(`status: ${run.status}`);
  console.log(`heartbeat_at: ${run.heartbeatAt ? run.heartbeatAt.toISOString() : 'never'}`);
  console.log(`last_tick_ts: ${run.lastTickTs ? run.lastTickTs.toISOString() : 'never'}`);
  console.log(`stop_reason: ${run.stopReason ?? 'none'}`);
  const resumes = resumesOf(run);
  console.log(`resumes: ${resumes.length}${resumes.length ? ` (last ${resumes[resumes.length - 1]})` : ''}`);
}

/**
 * `--day` report: window, the day's summary (mark-to-market and executable equity, return, fills,
 * rejects with reasons, the `stale t+1` count, fees), the same assumed-venue-costs warning
 * `printReport` prints (a day view should not hide that its fills' fees were assumed rather than
 * documented — review finding, Task 5 round 1), and — for paper runs — a heartbeat-age line so an
 * operator can tell a live run apart from one that stopped ticking mid-day. Exported for direct
 * unit testing with a console spy, the same pattern `printReport` already uses.
 */
export function printDayReport(
  run: RunRow, ticker: string, from: Date, to: Date, equity: EquityPoint[], orders: Array<OrderRecord & { baseUnit: string }>, now: Date,
): void {
  if (run.rehearsal) console.log('REHEARSAL — synthetic data — not evidence');
  console.log(`\n=== run ${run.id} | ${run.mode} | ${run.strategyId} | ${ticker} | day ${from.toISOString().slice(0, 10)}`);
  console.log(`window: ${from.toISOString()} -> ${to.toISOString()}`);
  const s = summarizeDay(equity, orders);
  console.table([{
    points: s.points,
    startAda: s.startEquity !== null ? adaStr(s.startEquity) : '-',
    endAda: s.endEquity !== null ? adaStr(s.endEquity) : '-',
    startExecAda: s.startExecutable !== null ? adaStr(s.startExecutable) : '-',
    endExecAda: s.endExecutable !== null ? adaStr(s.endExecutable) : '-',
    returnPct: s.returnPct ?? '-',
    filled: s.filled, rejected: s.rejected, staleRejects: s.staleRejects,
    feesAda: adaStr(s.feesLovelace), poolFeesIn: s.poolFeesIn.toString(),
  }]);
  const assumed = assumedVenuesTouched(orders);
  if (assumed.length) console.log(`warning: fills touched venues with ASSUMED costs: ${assumed.join(', ')} (see runs.params.costs.venues)`);
  if (Object.keys(s.rejectReasons).length) console.table(Object.entries(s.rejectReasons).map(([reason, count]) => ({ reason, count })));
  if (run.mode === 'paper') {
    const ageS = run.heartbeatAt ? Math.round((now.getTime() - run.heartbeatAt.getTime()) / 1000) : null;
    console.log(ageS !== null ? `heartbeat age: ${ageS}s` : 'no heartbeat');
  }
}

export async function reportCommand(log: Logger, args: string[]): Promise<void> {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id <= 0) throw new Error(USAGE);
  let dayArg: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--day') {
      // A missing value (e.g. `--day` as the last argument) previously left `dayArg` undefined,
      // which is indistinguishable from "no --day at all" below and silently fell through to the
      // non-day report instead of failing (review finding, Task 5 round 1).
      const value = args[i + 1];
      if (value === undefined) throw new Error(USAGE);
      dayArg = value;
      i++;
    }
  }
  // Validate before opening a pool so a malformed --day fails fast without a DB round trip.
  const window = dayArg !== undefined ? dayWindow(dayArg) : null;
  const cfg = loadConfig(process.env, { blockfrost: false });
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const runs = new PgRunRepo(db);
    const run = await runs.getRun(id);
    if (!run) throw new Error(`no run ${id}`);
    const universe = await loadUniverse();
    const ticker = universe.tokens.find((t) => t.unit === run.baseUnit)?.ticker ?? run.baseUnit;
    if (window) {
      const [equity, orders] = await Promise.all([runs.listEquity(id, window.from, window.to), runs.listOrdersBetween(id, window.from, window.to)]);
      printDayReport(run, ticker, window.from, window.to, equity, orders, new Date());
    } else {
      // Finding C1: a paper run's headline is recomputed from every persisted row, so a resumed run
      // is not reported as just its last segment. `new Date(0)` rather than `run.created_at`: on
      // rehearsal run 6 the first two equity points (18:31:58, the feed's first bucket) predate the
      // `runs` row itself (18:32:03), so anchoring the window at `created_at` would silently drop
      // 2 of 27 rows — the very truncation this finding exists to remove.
      const equity = run.mode === 'paper' ? await runs.listEquity(id, new Date(0), new Date()) : [];
      printReport(run, await runs.listOrders(id), ticker, equity);
    }
  } finally {
    await db.end();
  }
}
