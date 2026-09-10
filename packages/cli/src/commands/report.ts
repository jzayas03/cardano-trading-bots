import { createPool } from '@ctb/db';
import { PgRunRepo, type EquityPoint, type OrderRecord, type RunRow } from '@ctb/engine';
import { adaStr, coverageLine, COMPARE_REHEARSAL_BANNER, feedCountersLine, MIXED_TOKENS_WARNING, resumesOf, roundTrips, roundTripStats, stakingCredit, summarizeDay, summarizeRun, withStakingCredit, ASSUMED_STAKING_APR_PCT, type DaySummary } from '@ctb/reports';
import { assumedVenuesTouched } from '@ctb/sim-executor';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { csvFileNames, equityCsv, ordersCsv } from '../csv.js';
import { compareRunRows, type CompareRunInput } from '../compare.js';

export { adaStr, coverageLine, feedCountersLine, summarizeDay, summarizeRun, type DaySummary };

const USAGE = 'usage: report <run-id> [--day YYYY-MM-DD] [--csv <dir>] | report --compare <run-id>[,<run-id>...]';
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
  // Outside the paper branch on purpose: a backtest persists orders but no equity, and its fills are
  // the only corpus with enough completed round trips to say anything about their DISTRIBUTION.
  for (const line of renderRoundTrips(orders)) console.log(line);
  for (const line of renderStaking(persistedEquity)) console.log(line);
  if (!run.summary) { console.log('run has no summary (unfinished)'); return; }
  const s = run.summary;
  console.log(coverageLine(s.coverage));
  for (const w of s.warnings ?? []) console.log(`warning: ${w}`);
  console.table([{ candles: s.candles, intents: s.intents, filled: s.filled, rejected: s.rejected, startAda: adaStr(s.startEquityLovelace), endAda: adaStr(s.endEquityLovelace),
    returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct, lovelaceFeesAda: adaStr(s.feesLovelace),
    poolFeeAda: s.poolFeesInLovelace !== undefined ? adaStr(s.poolFeesInLovelace) : 'not recorded',
    poolFeeBase: s.poolFeesInBase ?? 'not recorded' }]);
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
/**
 * The run as a DISTRIBUTION of completed trades rather than one aggregate. Six small losses and one
 * lucky win produce the same run-level return as seven mediocre trades, and only one of those is a
 * strategy. It also checks the promotion gate's own arithmetic: n = 30 came from converting a median
 * move into a σ under an assumption of normality, and both halves of that are printed here.
 */
/**
 * What the run's idle ADA would have earned delegated. Always SHOWN and never folded into the
 * headline: the rate is assumed, and a headline that silently depends on an assumption is how a
 * number stops being questioned. It is printed because the opportunity cost of holding ADA is not
 * zero, and every baseline that ignores it understates the alternative.
 */
export function renderStaking(equity: readonly EquityPoint[], aprPct = ASSUMED_STAKING_APR_PCT): string[] {
  if (equity.length < 2) return [];
  const credit = stakingCredit(equity, aprPct);
  const before = summarizeRun(equity, []);
  const after = summarizeRun(withStakingCredit(equity, aprPct), []);
  if (before.returnPct === null || after.returnPct === null) return [];
  return [
    '',
    `idle ADA at ${aprPct}% APR (ASSUMED, not measured — replace with a real figure)`,
    `  credit ${adaStr(credit)} ADA over this window`,
    `  return ${before.returnPct.toFixed(2)}% -> ${after.returnPct.toFixed(2)}% once idle cash is credited`,
    '  Every baseline that ignores this understates the alternative: holding ADA is not a zero yield.',
  ];
}

export function renderRoundTrips(orders: readonly OrderRecord[]): string[] {
  const trips = roundTrips(orders);
  const s = roundTripStats(orders, trips);
  const n = (v: number | null, d = 1): string => (v === null ? '--' : v.toFixed(d));
  if (s.trips === 0) {
    return ['', `round trips   NONE — ${s.openLots} open lot(s), ${s.unmatchedSells} unmatched sell(s); nothing completed a buy-to-sell cycle`];
  }
  const out = ['', 'round trips (FIFO pairing of filled orders)'];
  out.push(`  ${s.trips} trips | ${s.unmatchedSells} unmatched sells | ${s.openLots} lot(s) still open`);
  out.push(`  return   median ${n(s.medianReturnBps)} bps, mean ${n(s.meanReturnBps)} bps, stdev ${n(s.stdevBps)} bps`);
  out.push(`  shape    median|return| ${n(s.medianAbsReturnBps)} bps -> implies sigma ${n(s.normalImpliedStdevBps)} bps IF normal`);
  out.push(`           excess kurtosis ${n(s.excessKurtosis, 2)}   (0 = normal, positive = fat tails)`);
  if (s.stdevBps !== null && s.normalImpliedStdevBps !== null) {
    const ratio = s.stdevBps / s.normalImpliedStdevBps;
    out.push(`           measured stdev is ${ratio.toFixed(2)}x the normal-implied one` +
      (ratio > 1.25 || ratio < 0.8 ? '  — THE NORMAL CONVERSION DOES NOT HOLD HERE' : ''));
  }
  // The scale carries the run's own price denomination; the shape does not. Said every time, because
  // the corpora with enough trips today are external-candle backtests priced in USD.
  out.push('  NOTE     bps figures inherit this run\'s price denomination (external-source runs are USD).');
  out.push('           Excess kurtosis is dimensionless and survives that; sigma does not.');
  return out;
}

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
    startTokens: s.startBaseTokens ?? '-', endTokens: s.endBaseTokens ?? '-', returnTokenPct: s.returnBasePct ?? '-',
    filled: s.filled, rejected: s.rejected, staleRejects: s.staleRejects,
    feesAda: adaStr(s.feesLovelace), poolFeeAda: adaStr(s.poolFeesInLovelace), poolFeeBase: s.poolFeesInBase.toString(),
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
  console.log(feedCountersLine(run.params));
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
  // Finding I3: spec §8 M3 requires the DAILY report to cite the git sha. The non-day report always
  // did; a reader who only ever saw `--day` output could not tell which code produced the numbers.
  console.log(`\n=== run ${run.id} | ${run.mode} | ${run.strategyId} | ${ticker} | day ${from.toISOString().slice(0, 10)} | git ${run.gitSha}`);
  console.log(`window: ${from.toISOString()} -> ${to.toISOString()}`);
  if (run.mode === 'paper') console.log(feedCountersLine(run.params));
  const s = summarizeDay(equity, orders);
  console.table([{
    points: s.points,
    startAda: s.startEquity !== null ? adaStr(s.startEquity) : '-',
    endAda: s.endEquity !== null ? adaStr(s.endEquity) : '-',
    startExecAda: s.startExecutable !== null ? adaStr(s.startExecutable) : '-',
    endExecAda: s.endExecutable !== null ? adaStr(s.endExecutable) : '-',
    returnPct: s.returnPct ?? '-',
    startTokens: s.startBaseTokens ?? '-', endTokens: s.endBaseTokens ?? '-', returnTokenPct: s.returnBasePct ?? '-',
    filled: s.filled, rejected: s.rejected, staleRejects: s.staleRejects,
    feesAda: adaStr(s.feesLovelace), poolFeeAda: adaStr(s.poolFeesInLovelace), poolFeeBase: s.poolFeesInBase.toString(),
  }]);
  const assumed = assumedVenuesTouched(orders);
  if (assumed.length) console.log(`warning: fills touched venues with ASSUMED costs: ${assumed.join(', ')} (see runs.params.costs.venues)`);
  if (Object.keys(s.rejectReasons).length) console.table(Object.entries(s.rejectReasons).map(([reason, count]) => ({ reason, count })));
  if (run.mode === 'paper') {
    const ageS = run.heartbeatAt ? Math.round((now.getTime() - run.heartbeatAt.getTime()) / 1000) : null;
    console.log(ageS !== null ? `heartbeat age: ${ageS}s` : 'no heartbeat');
  }
}

export interface ReportArgs { id: number; day: string | undefined; csvDir: string | undefined; compare: number[] | undefined }

/**
 * `--compare 14,15,16`: positive integers, no empties, no repeats — fewer runs than typed is refused,
 * not dropped.
 *
 * Final review, IMPORTANT 1: the dashboard's `/compare?ids=` used the identical `!Number.isInteger(n)`
 * shape check this function does, and a reviewer showed it accepts values it should refuse — `1e21`
 * reaches Postgres as a bigint parameter and 500s, `0x10` silently parses as `Number('0x10') === 16`
 * and would run against the WRONG run with no error at all, and `+1`/`1.0` also slip through since
 * `Number()` parses all of them and `Number.isInteger` doesn't care. Both surfaces are fixed together
 * here with the identical `/^\d+$/` shape check the dashboard now uses (see `server.ts`'s own
 * `parseCompareIds`), so `report --compare` and `/compare?ids=` keep agreeing about what a run id is.
 */
export function parseCompareList(raw: string): number[] {
  const ids = raw.split(',').map((x) => {
    const trimmed = x.trim();
    const n = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n) || n <= 0) throw new Error(`--compare needs run ids, got ${JSON.stringify(x)} in "${raw}"\n${USAGE}`);
    return n;
  });
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup !== undefined) throw new Error(`run ${dup} listed more than once\n${USAGE}`);
  return ids;
}

export function parseReportArgs(args: string[]): ReportArgs {
  if (args[0] === '--compare') {
    if (args[1] === undefined || args[1].startsWith('--')) throw new Error(`--compare needs a value\n${USAGE}`);
    if (args.length > 2) throw new Error(`--compare takes no other flags\n${USAGE}`);
    return { id: 0, day: undefined, csvDir: undefined, compare: parseCompareList(args[1]) };
  }
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id <= 0) throw new Error(USAGE);
  const out: ReportArgs = { id, day: undefined, csvDir: undefined, compare: undefined };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--compare') throw new Error(`--compare stands alone: report --compare <ids>\n${USAGE}`);
    if (flag === '--day' || flag === '--csv') {
      // A missing value (e.g. `--day` as the last argument) previously left the value undefined,
      // which is indistinguishable from "no flag at all" below and silently fell through to the
      // plain report instead of failing (review finding, Task 5 round 1).
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
      if (flag === '--day') out.day = value; else out.csvDir = value;
      i++;
      continue;
    }
    // Finding M2: anything else used to be skipped in silence, so `report 6 --dya 2026-09-06` — or a
    // stray shell word — produced a confident full-run report instead of the day the operator asked
    // for. Every other command in this CLI rejects an unknown flag; this one now does too.
    throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  if (out.day !== undefined && out.csvDir !== undefined) throw new Error(`--csv exports the whole run; it does not combine with --day\n${USAGE}`);
  return out;
}

/**
 * Writes the run's persisted rows as CSV files an operator can plot. Never overwrites: `wx` fails on
 * an existing file, and the error names it — a re-export onto a file someone is already reading
 * would change the numbers under them. Returns the paths written, for the caller to print.
 */
export function writeCsvExport(dir: string, run: RunRow, orders: OrderRecord[], equity: EquityPoint[]): string[] {
  mkdirSync(dir, { recursive: true });
  const names = csvFileNames(run);
  const written: string[] = [];
  const write = (name: string, body: string): void => {
    const path = join(dir, name);
    try {
      writeFileSync(path, body, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${path} already exists; move it aside before exporting again`);
      throw e;
    }
    written.push(path);
  };
  write(names.orders, ordersCsv(orders));
  if (run.mode === 'paper') write(names.equity, equityCsv(equity));
  return written;
}

/**
 * `report --compare`: the persisted-rows headline of several runs side by side, in the order given.
 * Every row's numbers are what `report <id>` prints for that run; nothing is recomputed differently
 * here. A rehearsal run anywhere in the list puts the banner above the table AND the word on its row.
 */
export function printCompare(inputs: CompareRunInput[], now: Date): void {
  if (inputs.some((i) => i.run.rehearsal)) console.log(COMPARE_REHEARSAL_BANNER);
  const tickers = [...new Set(inputs.map((i) => i.ticker))];
  console.log(`\n=== compare ${inputs.map((i) => i.run.id).join(',')} | ${tickers.join(', ')} | as of ${now.toISOString()}`);
  if (tickers.length > 1) console.log(MIXED_TOKENS_WARNING);
  const rows = compareRunRows(inputs, now);
  // `blocker` is a sentence, not a cell: it triples the table's width and is printed in full below.
  // Stripped by destructuring rather than by an explicit column list, so adding a future column
  // cannot silently drop it from the table the way a hand-maintained list would.
  console.table(rows.map(({ blocker: _blocker, ...rest }) => rest));
  // The blocker is too long for a table cell and too important to drop. Printed once per barred run,
  // under the table, so the gate can be audited rather than merely obeyed.
  const barred = rows.filter((r) => r.promotion !== 'candidate' && r.blocker !== '');
  if (barred.length > 0) {
    console.log('\npromotion gate — why each run is still experimental:');
    for (const r of barred) console.log(`  run ${r.run} ${r.strategy}: ${r.blocker}`);
    console.log('The gate BARS promotion; thresholds were fixed before this run\'s results existed.');
  }
}

export async function reportCommand(log: Logger, args: string[]): Promise<void> {
  const { id, day: dayArg, csvDir, compare } = parseReportArgs(args);
  // Validate before opening a pool so a malformed --day fails fast without a DB round trip.
  const window = dayArg !== undefined ? dayWindow(dayArg) : null;
  const cfg = loadConfig(process.env, { blockfrost: false });
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const runs = new PgRunRepo(db);
    const universe = await loadUniverse();
    if (compare) {
      const now = new Date();
      const inputs: CompareRunInput[] = [];
      for (const rid of compare) {
        const r = await runs.getRun(rid);
        if (!r) throw new Error(`no run ${rid}`);
        const [equity, orders] = await Promise.all([runs.listEquity(rid, new Date(0), now), runs.listOrders(rid)]);
        inputs.push({ run: r, ticker: universe.tokens.find((t) => t.unit === r.baseUnit)?.ticker ?? r.baseUnit, equity, orders });
      }
      printCompare(inputs, now);
      return;
    }
    const run = await runs.getRun(id);
    if (!run) throw new Error(`no run ${id}`);
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
      const orders = await runs.listOrders(id);
      printReport(run, orders, ticker, equity);
      if (csvDir !== undefined) {
        for (const path of writeCsvExport(csvDir, run, orders, equity)) console.log(`wrote ${path}`);
        if (run.mode !== 'paper') console.log('no equity file: backtest runs persist orders only (equity is not stored for them)');
        if (run.rehearsal) console.log('REHEARSAL — the files are named accordingly; synthetic data, not evidence');
      }
    }
  } finally {
    await db.end();
  }
}
