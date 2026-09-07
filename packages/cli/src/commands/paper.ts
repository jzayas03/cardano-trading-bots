import { PgCandleRepo, type CandleRepo } from '@ctb/candles';
import { createPool, withTransaction, type Db, type Queryable } from '@ctb/db';
import {
  gitShaOrUnknown, PgRunRepo, runEngine, STRATEGIES,
  type Candle, type EquityPoint, type FeedCounters, type OrderRecord, type Portfolio, type RunRepo, type RunRow, type RunSummaryStats, type Strategy,
} from '@ctb/engine';
import { SimExecutor } from '@ctb/sim-executor';
import { retryWithBackoff } from '@ctb/collector';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { ensureTokens } from '../ensureTokens.js';
import { assertFakeAllowed } from '../fakeWalk.js';
import { loadUniverse, type TokenSpec } from '@ctb/universe';
import { candleFromRow, liveCandleFeed, type FeedTickInfo, type LiveFeedDeps } from '../liveFeed.js';
import { isHeartbeatStale } from './status.js';
import { sleep } from '../schedule.js';
import { buildRunParams } from './backtest.js';
import { printReport } from './report.js';

export interface PaperArgs {
  strategyId: string; ticker: string;
  /** null when `--cash-ada` was not given. Distinguishing "not given" from "given as the default"
   * is what lets `--resume` refuse a flag that would silently do nothing (finding M5). */
  cashAda: number | null;
  resume: number | null;
  /** null when `--interval-sec` was not given: the collector's own `COLLECT_INTERVAL_SECONDS` is
   * then the default, rather than a hard-coded 300 unrelated to it (finding I2). */
  intervalSec: number | null;
  /** Proceed with an interval that differs from the collector's, recorded in the run's params. */
  allowIntervalMismatch: boolean;
  graceSec: number; maxGapMin: number; rehearsal: boolean; params: Record<string, number>;
  /**
   * Consecutive failing feed boundaries after which the run stops itself (finding I5); 0 disables
   * the rule. 12 is a deliberate default: at the 300 s production interval that is an hour of a run
   * getting nothing from its database or its candle builder, which is long past a blip.
   */
  maxTickFailures: number;
}

const USAGE = 'usage: paper <strategy> <TICKER> [--cash-ada N] [--resume RUN_ID] [--interval-sec COLLECT_INTERVAL_SECONDS] [--allow-interval-mismatch] [--grace-sec 60] [--max-gap-min 15] [--max-tick-failures 12] [--rehearsal] [--param k=v]...';
const ada = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

export function parsePaperArgs(args: string[]): PaperArgs {
  const [strategyId, ticker, ...rest] = args;
  if (!strategyId || !ticker) throw new Error(USAGE);
  const out: PaperArgs = {
    strategyId, ticker, cashAda: null, resume: null, intervalSec: null, allowIntervalMismatch: false,
    graceSec: 60, maxGapMin: 15, rehearsal: false, params: {}, maxTickFailures: 12,
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
      case '--max-tick-failures': out.maxTickFailures = num(flag, val, 0); i++; break;
      case '--allow-interval-mismatch': out.allowIntervalMismatch = true; break;
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

/**
 * Finding F2: a resumed run must not silently trade under different strategy params than the run it
 * is continuing — an equity curve that starts under `slow=10` and, after a resume, keeps going under
 * `slow=20` is not one comparable series, and nothing before this said so. `current` is the same merge
 * `runEngine` performs (`{ ...strategy.defaultParams, ...a.params }`); `prior` is the persisted
 * `runs.params` jsonb blob, which flattens strategy params at the top level next to `cashAda` etc.
 * (see `buildRunParams`) — so only `current`'s own keys are checked, and a key `prior` never recorded
 * (an older run predating a new param, or one of the non-strategy keys like `cashAda`) is ignored
 * rather than treated as a mismatch. Compared with `Number(...)` because jsonb round-trips a number
 * that was written as a numeric literal back out the same way node-postgres always does — as text.
 */
/**
 * Task 6 rehearsal defect (found by actually running the stop/resume cycle in Step 3, not by any
 * unit test — no test exercised `paperCommand` end to end before this): the ONLY way a live paper
 * run ever stops is a signal (`liveCandleFeed` loops forever while `!signal.aborted`; the
 * `'feed ended'` stop_reason this file also writes is unreachable for paper mode today), and that
 * signal path always records `status: 'finished'`. The guard here used to refuse to resume exactly
 * that status — `if (prior.status === 'finished') throw ...` — which meant `--resume` could never
 * succeed on the one kind of run it exists to serve; `RunRepo.setStatus`'s own doc comment
 * ("re-entering 'running' on resume clears [finished_at]") already assumed resuming a finished run
 * was the normal path, so the check contradicted the interface it sat next to. The real hazard is a
 * SECOND process resuming a run a FIRST process is still actively running: two writers on one
 * `run_id` would race `paper_orders.seq` (both read the same `lastOrderSeq` and insert the same next
 * seq) and `run_equity` inserts — so this now blocks `'running'` instead of `'finished'`.
 */
/**
 * Final-review finding C2: a paper process that dies WITHOUT reaching its catch block — `kill -9`, an
 * OOM kill, a lost machine — never runs `setStatus`, so the row stays `'running'` forever and a flat
 * "refuse every running run" rule made that run permanently unresumable; the operator's only
 * recovery was hand-editing `runs.status`, which no runbook documented. The hazard the rule exists
 * for is a SECOND writer joining a run a FIRST process is still actively writing (both would read
 * the same `lastOrderSeq` and race `paper_orders`), and that hazard requires the first process to be
 * ALIVE. Liveness is exactly what the heartbeat measures, so the refusal now asks
 * `isHeartbeatStale` — the same bound `status` prints — instead of the status alone. A dead-but-
 * `running` row resumes; a live one is still refused.
 */
export function resumeStatusError(run: Pick<RunRow, 'status' | 'heartbeatAt' | 'params'>, now: Date): string | null {
  if (run.status !== 'running') return null;
  if (isHeartbeatStale(run.heartbeatAt, run.params, now)) return null;
  return 'is already running; stop it (SIGINT) first, then resume';
}

/** Seconds since the last heartbeat, or null when the run never wrote one. Used only for the
 * operator-facing message on the stale-resume path. */
export function heartbeatAgeSec(heartbeatAt: Date | null, now: Date): number | null {
  return heartbeatAt ? Math.round((now.getTime() - heartbeatAt.getTime()) / 1000) : null;
}

export function paramsMismatch(prior: Record<string, unknown>, current: Record<string, number>): string | null {
  for (const key of Object.keys(current)) {
    const p = prior[key];
    if (p !== undefined && Number(p) !== current[key]) {
      return `was started with ${key}=${p}, not ${current[key]}; start a new run`;
    }
  }
  return null;
}

/** `--cash-ada` when it is not given. A fresh run with no flag starts on 1000 ADA, as it always has. */
export const DEFAULT_CASH_ADA = 1000;

/**
 * Finding I2: `--interval-sec` defaulted to a hard-coded 300 with no relation to the collector's own
 * `COLLECT_INTERVAL_SECONDS`. The paper feed sleeps to ITS interval's boundaries and then reads
 * candles bucketed at the COLLECTOR's, so a mismatch means every boundary lands where no snapshot
 * exists: a run that heartbeats forever, yields almost nothing, and has no error anywhere to explain
 * it — the silent shape, not the loud one. Task 6's rehearsal set both to 60 by hand, which is
 * exactly why nothing caught this. An operator who really wants a different cadence says so.
 */
export function resolveIntervalSec(argIntervalSec: number | null, configIntervalSec: number, allowMismatch: boolean): number {
  if (argIntervalSec === null) return configIntervalSec;
  if (argIntervalSec !== configIntervalSec && !allowMismatch) {
    throw new Error(
      `--interval-sec ${argIntervalSec} differs from COLLECT_INTERVAL_SECONDS ${configIntervalSec}; the collector's boundaries would not line up` +
      '\npass --allow-interval-mismatch if that is deliberate',
    );
  }
  return argIntervalSec;
}

/**
 * Finding M5: `--cash-ada` was accepted alongside `--resume` and then silently ignored — a resumed
 * run's portfolio comes from its last equity row. `--resume 6 --cash-ada 5000` continued on the old
 * balance with nothing to say the flag had done nothing. It is only refused when there IS an equity
 * row to restore from: resuming a run that never wrote one has no other source for a balance.
 */
export function cashAdaOnResumeError(cashAdaGiven: boolean, hasRestoredEquity: boolean): string | null {
  return cashAdaGiven && hasRestoredEquity ? 'cash is restored from the run; --cash-ada is not allowed with --resume' : null;
}

/**
 * Finding I7: how much synthetic data this token carries, in BOTH tables and with no time window.
 * The old guard counted `pool_snapshots` alone, inside a 24-hour window, and both halves were holes.
 * `candles` is the table the paper feed actually reads — a `Fake:` candle outlives the snapshot it
 * was built from, and a run that believes it is trading real data would fill against it. And the
 * window meant a rehearsal left alone for a day stopped being detectable at all, so "synthetic data
 * can never be mistaken for real" quietly expired on a timer.
 */
export async function fakeRowsPresent(db: Queryable, baseUnit: string): Promise<{ snapshots: number; candles: number }> {
  const snapshots = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM pool_snapshots WHERE base_unit = $1 AND dex = $2', [baseUnit, FAKE_DEX]);
  const candles = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM candles WHERE base_unit = $1 AND pool_id LIKE $2', [baseUnit, `${FAKE_DEX}:%`]);
  return { snapshots: Number(snapshots.rows[0]?.n ?? 0), candles: Number(candles.rows[0]?.n ?? 0) };
}

/** The dashboard's rehearsal-data check (health page) has no single token to scope to like a paper
 * run does — this is `fakeRowsPresent` without the `base_unit` filter, same two tables, same `Fake`
 * marker, total across the whole database. */
export async function fakeRowsTotal(db: Queryable): Promise<{ snapshots: number; candles: number }> {
  const snapshots = await db.query<{ n: string }>('SELECT count(*) AS n FROM pool_snapshots WHERE dex = $1', [FAKE_DEX]);
  const candles = await db.query<{ n: string }>('SELECT count(*) AS n FROM candles WHERE pool_id LIKE $1', [`${FAKE_DEX}:%`]);
  return { snapshots: Number(snapshots.rows[0]?.n ?? 0), candles: Number(candles.rows[0]?.n ?? 0) };
}

/** The synthetic venue `dev:fake-collector` writes under. One definition, matched in both tables. */
const FAKE_DEX = 'Fake';

/**
 * Finding I5: how a run stops itself when its feed is not merely slow but broken. `liveCandleFeed`
 * swallows every boundary error and loops forever, so before this a paper run whose database or
 * candle builder was permanently broken kept heartbeating and kept reporting `status = 'running'`
 * while never trading again — a healthy-looking process producing nothing, which is the worst shape
 * a failure can take because nothing alerts on it. The streak (reset by any clean tick) is what
 * separates a blip from that. `maxTickFailures: 0` disables the rule for an operator who wants the
 * old behaviour.
 */
export function tickFailureAbortReason(info: FeedTickInfo, maxTickFailures: number): string | null {
  if (maxTickFailures <= 0 || !info.failed) return null;
  if (info.consecutiveFailures < maxTickFailures) return null;
  return `feed failing: ${info.lastError ?? 'unknown error'}`;
}

/** The counters a run already carries, so a resumed segment continues the totals instead of
 * restarting them at zero and making the run look like it saw a fraction of the boundaries it did.
 * A run predating the counters, or one whose jsonb holds anything else, starts from zero. */
export function readFeedCounters(params: Record<string, unknown>): FeedCounters {
  const zero: FeedCounters = { ticks: 0, built: 0, yielded: 0, skippedStale: 0, emptyBoundaries: 0, tickFailures: 0 };
  const raw = params.feedCounters;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return zero;
  const c = raw as Record<string, unknown>;
  const n = (k: keyof FeedCounters): number => (typeof c[k] === 'number' && Number.isFinite(c[k]) ? (c[k] as number) : 0);
  return { ticks: n('ticks'), built: n('built'), yielded: n('yielded'), skippedStale: n('skippedStale'), emptyBoundaries: n('emptyBoundaries'), tickFailures: n('tickFailures') };
}

/** Finding I4: running totals, one boundary at a time. A failed boundary is still a tick. */
export function accumulateFeedCounters(totals: FeedCounters, info: FeedTickInfo): FeedCounters {
  return {
    ticks: totals.ticks + 1,
    built: totals.built + info.built,
    yielded: totals.yielded + info.yielded,
    skippedStale: totals.skippedStale + info.skippedStale,
    emptyBoundaries: totals.emptyBoundaries + (info.emptyBoundary ? 1 : 0),
    tickFailures: totals.tickFailures + (info.failed ? 1 : 0),
  };
}

/** Postgres SQLSTATEs worth retrying: class 08 (connection exception) is matched by prefix, the rest
 * exactly. 57P01 admin_shutdown, 40001 serialization_failure, 40P01 deadlock_detected. */
const TRANSIENT_PG_CODES = new Set(['57P01', '40001', '40P01']);
/** Socket-level failures node-postgres surfaces as `err.code` rather than a SQLSTATE. */
const TRANSIENT_SOCKET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
/** node-postgres raises these with no code at all, only a message. Anchored phrases, not loose
 * number matching: `isTransientHttpError`'s message-text approach would retry an error mentioning a
 * pool reserve of 503000 as if the database had hiccuped. */
const TRANSIENT_PG_MESSAGES = /Connection terminated|terminating connection|Client has encountered a connection error|server closed the connection|timeout exceeded when trying to connect|Connection ended unexpectedly|query_timeout/i;

/**
 * Whether the commit sink should retry (finding I1b). Retrying only helps for a failure a later
 * attempt could survive: a dropped connection, a database restarting under us, a serialization
 * failure. A constraint violation or a bad type is a bug that will fail identically five times, so
 * it escapes at once and aborts the run — which is correct, because a run that cannot persist a
 * candle must not keep trading as if it had.
 */
export function isTransientPgError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (code.startsWith('08')) return true;
    if (TRANSIENT_PG_CODES.has(code) || TRANSIENT_SOCKET_CODES.has(code)) return true;
    // A SQLSTATE that is not on the list is a real, reproducible database answer: do not retry it.
    if (/^[0-9A-Z]{5}$/.test(code)) return false;
  }
  return TRANSIENT_PG_MESSAGES.test(err.message);
}

/**
 * The last `warmup` candles at or before `afterTick`, as the engine's `Candle` — a resumed run's
 * indicator seed (finding I6). The read window reaches back `warmup * intervalSec * 2` so a sparse
 * stretch (missed collector ticks, a gap) still has a chance of yielding `warmup` rows rather than
 * silently priming with fewer; whatever comes back is sliced to the last `warmup`, so an over-wide
 * window costs one bounded query and never over-primes. Fewer than `warmup` rows is not an error —
 * the run simply warms up the rest of the way live, exactly as it would have without this.
 */
export async function readPrimeHistory(
  repo: CandleRepo, baseUnit: string, afterTick: Date, warmup: number, intervalSec: number,
): Promise<Candle[]> {
  if (warmup <= 0) return [];
  const from = new Date(afterTick.getTime() - warmup * intervalSec * 1000 * 2);
  const rows = await repo.readCandles(baseUnit, from, afterTick);
  return rows.slice(-warmup).map(candleFromRow);
}

/**
 * Thin process shell (finding M7): argument parsing, the config gates, the pool, the signal
 * handlers, and the repos — everything that needs a real process — with the run itself delegated to
 * `runPaper` below. `paperCommand` was a single function that did all of this inline, which is why
 * every defect this review found in the paper loop (C1, C2, I1, I5, I6) had to be found by
 * hand-running a rehearsal instead of by a test.
 */
export async function paperCommand(log: Logger, args: string[]): Promise<void> {
  const a = parsePaperArgs(args);
  const strategy = STRATEGIES[a.strategyId];
  if (!strategy) throw new Error(`unknown strategy ${a.strategyId}; known: ${Object.keys(STRATEGIES).join(', ')}`);
  const cfg = loadConfig(process.env, { blockfrost: false });
  // Finding I7: the consumer of synthetic data gets the same two-part gate as the producer — the
  // explicit opt-in AND a localhost database. Checked before anything else touches the database.
  if (a.rehearsal) assertFakeAllowed(process.env, cfg.databaseUrl, 'paper --rehearsal');
  const universe = await loadUniverse();
  const token = universe.tokens.find((t) => t.ticker === a.ticker);
  if (!token) throw new Error(`unknown ticker ${a.ticker}; not in universe.json`);
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  const ac = new AbortController();
  const onSignal = (sig: string): void => { log.info({ sig }, 'stopping after the current candle'); ac.abort(); };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  try {
    // ensureTokens MUST run before the first FK-writing repo is constructed (finding F4):
    // `runs.base_unit` is FK'd to tokens(unit), the same as every other command that touches this
    // table. `commandsSyncTokens.test.ts` pins this ordering by reading this file's source.
    await ensureTokens(db, universe);
    await runPaper({
      db, runs: new PgRunRepo(db), candleRepo: new PgCandleRepo(db), token, strategy, args: a,
      collectIntervalSec: cfg.intervalSec, log, now: () => new Date(), sleep, signal: ac.signal,
    });
  } finally {
    await db.end();
  }
}

/** Everything `runPaper` needs from the outside, so the loop can be exercised against a real
 * database with a scripted feed and a fake clock instead of a real process and a real hour. */
export interface RunPaperDeps {
  db: Db;
  runs: RunRepo;
  candleRepo: CandleRepo;
  token: Pick<TokenSpec, 'unit' | 'decimals' | 'ticker'>;
  strategy: Strategy;
  args: PaperArgs;
  /** `COLLECT_INTERVAL_SECONDS`: the cadence the collector writes at, which the paper clock must
   * agree with or silently miss every boundary (finding I2). */
  collectIntervalSec: number;
  log: Logger;
  now: () => Date;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  /** Replaces the live feed. A test scripts candles through the same `onTick` contract instead of
   * sleeping to real interval boundaries. */
  feedFactory?: (deps: LiveFeedDeps) => AsyncIterable<Candle>;
  /** Binds a repo to one transaction's client. Injectable so a test can make one commit fail. */
  bindRunRepo?: (q: Queryable) => RunRepo;
  /** Provenance for a NEW run; defaults to the working tree's HEAD. */
  gitSha?: string;
}

export interface RunPaperResult {
  runId: number;
  summary: RunSummaryStats;
  /** What the run row was left at. `aborted` means the feed-failure rule stopped it (finding I5). */
  status: 'finished' | 'aborted';
}

/**
 * One paper segment, start to stop: resolve or create the run, restore the portfolio and the seq on
 * a resume, run the engine against the live feed committing one candle per transaction, then close
 * the run out and print its report.
 */
export async function runPaper(d: RunPaperDeps): Promise<RunPaperResult> {
  const { args: a, db, runs, candleRepo, token, strategy, log } = d;
  // Finding I2: the paper clock and the collector's clock must agree, or every boundary lands where
  // no snapshot exists and the run yields nothing while looking perfectly healthy.
  const intervalSec = resolveIntervalSec(a.intervalSec, d.collectIntervalSec, a.allowIntervalMismatch);
  const bindRunRepo = d.bindRunRepo ?? ((q: Queryable) => new PgRunRepo(db, q));
  let runId: number | null = null;
  try {
    if (!a.rehearsal) {
      // Synthetic data can never be mistaken for real: any `Fake` snapshot OR any `Fake:` candle for
      // this token, of any age, means a rehearsal touched this database and never cleaned up.
      const fake = await fakeRowsPresent(db, token.unit);
      if (fake.snapshots > 0 || fake.candles > 0) {
        throw new Error(
          `rehearsal data present for this token (${fake.snapshots} Fake pool_snapshots, ${fake.candles} Fake candles); pass --rehearsal or clean the database`,
        );
      }
    }
    const maxGapMs = a.maxGapMin * 60_000;
    const cashAda = a.cashAda ?? DEFAULT_CASH_ADA;
    let initial: Portfolio = { cashLovelace: ada(cashAda), positionBase: 0n };
    let startSeq = 0;
    let afterTick: Date | null = null;
    let resumeWarning: string | undefined;
    let staleResumeWarning: string | undefined;
    if (a.resume !== null) {
      const prior = await runs.getRun(a.resume);
      if (!prior || prior.mode !== 'paper') throw new Error(`run ${a.resume} is not a paper run`);
      if (prior.strategyId !== strategy.id || prior.baseUnit !== token.unit) {
        throw new Error(`run ${a.resume} is ${prior.strategyId}/${prior.baseUnit}, not ${strategy.id}/${token.unit}`);
      }
      const resumeCheckedAt = d.now();
      const statusError = resumeStatusError(prior, resumeCheckedAt);
      if (statusError) throw new Error(`run ${a.resume} ${statusError}`);
      // Finding C2: resuming a row still marked `running` is the recovery path for a process that
      // died without its catch block. It is legitimate but it is not routine, so it goes on the
      // record — a log line AND a run warning — rather than passing silently as a normal resume.
      if (prior.status === 'running') {
        const ageS = heartbeatAgeSec(prior.heartbeatAt, resumeCheckedAt);
        staleResumeWarning = `resuming a run whose heartbeat is stale (age ${ageS === null ? 'never' : `${ageS}s`}); the previous process died without recording a stop`;
        log.warn({ runId: a.resume, heartbeatAt: prior.heartbeatAt, ageS }, `resuming a run whose heartbeat is stale (age ${ageS === null ? 'never' : `${ageS}s`})`);
      }
      // Finding F2: refuse to resume under strategy params that differ from the ones this run was
      // started with — a resumed equity curve that quietly switches `slow`/`fast` etc. mid-stream is
      // not comparable to itself before the resume.
      const current = { ...strategy.defaultParams, ...a.params };
      const mismatch = paramsMismatch(prior.params, current);
      if (mismatch) throw new Error(`run ${a.resume} ${mismatch}`);
      const last = await runs.lastEquity(a.resume);
      // Finding M5: refuse a flag that would silently do nothing rather than accept and ignore it.
      const cashError = cashAdaOnResumeError(a.cashAda !== null, last !== null);
      if (cashError) throw new Error(cashError);
      if (last) { initial = { cashLovelace: last.cashLovelace, positionBase: last.positionBase }; afterTick = last.tickTs; }
      startSeq = await runs.lastOrderSeq(a.resume);
      runId = a.resume;
      const resumedAt = d.now();
      await runs.appendResume(runId, resumedAt);
      await runs.setStatus(runId, 'running', null);
      // Finding F5: the intents pending at the previous stop were rejected `stopped` and never
      // re-decided — that loss belongs on the record, not just in a log line nobody re-reads.
      resumeWarning = `resumed at ${resumedAt.toISOString()} from ${afterTick?.toISOString() ?? 'start'}; intents pending at the previous stop were lost`;
      log.info({ runId, afterTick, startSeq }, 'resumed run; intents pending at the previous stop were lost');
    } else {
      runId = await runs.createRun({
        mode: 'paper', strategyId: strategy.id, gitSha: d.gitSha ?? gitShaOrUnknown(process.cwd()),
        baseUnit: token.unit, dataSource: 'candles', fillModel: 'cpmm_observed',
        dataFrom: d.now(), dataTo: d.now(),
        params: {
          ...buildRunParams(strategy.defaultParams, a.params, cashAda, null, {}, maxGapMs),
          intervalSec, graceSec: a.graceSec, rehearsal: a.rehearsal,
          collectIntervalSec: d.collectIntervalSec, allowIntervalMismatch: a.allowIntervalMismatch,
          maxTickFailures: a.maxTickFailures,
        },
        status: 'running', rehearsal: a.rehearsal,
      });
    }
    console.log(`run id: ${runId}${a.rehearsal ? ' (REHEARSAL)' : ''}`);
    const id = runId;
    const existingParams = (await runs.getRun(id))?.params ?? {};
    // Finding I6: a resumed run starts its indicators warm, from candles it already lived through,
    // instead of spending its first `warmup` boundaries structurally unable to emit an intent.
    const primeHistory = afterTick
      ? await readPrimeHistory(candleRepo, token.unit, afterTick, strategy.warmupFor({ ...strategy.defaultParams, ...a.params }), intervalSec)
      : undefined;
    if (primeHistory) log.info({ runId: id, primed: primeHistory.length, afterTick }, 'primed strategy history from persisted candles');
    // Plan 3 Task 6: `Fake` (dev:fake-collector's synthetic venue) is not a Dexter venue and would
    // otherwise be rejected as unknown; `rehearsalVenue` is only set here, so it costs DEFAULT_COSTS
    // ONLY for a --rehearsal run — a real paper run still refuses to fill against a Fake pool.
    const executor = new SimExecutor({ decimals: token.decimals, baseUnit: token.unit, fillModel: { kind: 'cpmm_observed' }, maxGapMs, rehearsalVenue: a.rehearsal ? 'Fake' : undefined });
    // Finding I4: the feed's per-boundary numbers, accumulated across the whole segment and written
    // to the run row, so a run that stopped seeing candles at 03:00 is distinguishable afterwards
    // from one that ran clean. Seeded from whatever the run already carries, so a resume continues
    // the totals instead of restarting them at zero.
    let feedCounters: FeedCounters = readFeedCounters(existingParams);
    /** Set when the feed-failure rule stops the run, so the exit path below leaves the `aborted`
     * status and its reason alone instead of overwriting them with `finished`. */
    let feedAbortReason: string | null = null;
    const ac = new AbortController();
    // One signal for the engine and the feed: the caller's (SIGINT, or a test's) OR this run's own
    // feed-failure abort. `d.signal` may already be aborted, in which case this fires immediately.
    if (d.signal.aborted) ac.abort();
    else d.signal.addEventListener('abort', () => ac.abort(), { once: true });

    const feedDeps: LiveFeedDeps = {
      repo: candleRepo, token, intervalSec, graceSec: a.graceSec, maxGapMs, now: d.now, sleep: d.sleep, signal: ac.signal, log, afterTick,
      onTick: async (info) => {
        feedCounters = accumulateFeedCounters(feedCounters, info);
        // These writes are inside the feed's own try (finding I1a): if Postgres is the thing that is
        // down, failing to record the heartbeat costs this boundary and counts as a tick failure —
        // it does not throw the run out of its loop, and the streak below is what eventually stops it.
        await runs.heartbeat(id, d.now(), null);
        await runs.updateFeedCounters(id, feedCounters);
        const abortReason = tickFailureAbortReason(info, a.maxTickFailures);
        if (abortReason) {
          log.error({ runId: id, consecutiveFailures: info.consecutiveFailures, lastError: info.lastError }, 'stopping run: the feed has failed too many boundaries in a row');
          feedAbortReason = abortReason;
          await runs.setStatus(id, 'aborted', abortReason);
          ac.abort();
        }
      },
    };
    const feed = (d.feedFactory ?? liveCandleFeed)(feedDeps);

    /**
     * Finding I1(b): one candle, one transaction. The per-event sinks wrote each candle's orders and
     * its equity point in separate autocommit statements, so a crash between them left the database
     * claiming a fill no equity point reflects — the run's own "every order and every equity point is
     * persisted before the loop moves to the next candle" could not actually hold. A `RunRepo` bound
     * to the transaction's client (the shape `PgCandleRepo.transaction` already uses) writes orders,
     * equity and the heartbeat together or not at all.
     *
     * Wrapped in a bounded retry because a five-second database blip must cost a candle, not a run.
     * The budget is half a boundary (`intervalSec * 500` ms): past that, retrying has eaten the time
     * the next candle needs, so failing and letting the run abort is the honest outcome. Only
     * transient failures retry — a constraint violation escapes at once and aborts the run, which is
     * the right direction: if a commit's ack was lost after it actually committed, the retry hits the
     * `(run_id, seq)` primary key, the run stops rather than double-writing, and `--resume` picks up
     * from `lastOrderSeq` with nothing lost.
     */
    const commitCandle = async (batch: { candle: Candle; orders: OrderRecord[]; equity: EquityPoint | null }): Promise<void> => {
      await retryWithBackoff(
        () => withTransaction(db, async (q) => {
          const tx = bindRunRepo(q);
          if (batch.orders.length > 0) await tx.insertOrders(id, token.unit, batch.orders);
          if (batch.equity) await tx.insertEquity(id, [batch.equity]);
          await tx.heartbeat(id, d.now(), batch.candle.tickTs);
        }),
        {
          attempts: 5, baseMs: 500, maxMs: 8_000, budgetMs: intervalSec * 500,
          isTransient: isTransientPgError,
          onRetry: ({ attempt, delayMs, message }) => log.warn({ runId: id, tickTs: batch.candle.tickTs, attempt, delayMs, err: message }, 'candle commit failed; retrying'),
        },
      );
    };

    const result = await runEngine({
      feed, strategy, params: a.params, executor, initial, decimals: token.decimals, log, retain: false, startSeq, signal: ac.signal,
      intervalSec, maxGapMs, primeHistory, initialWarnings: [staleResumeWarning, resumeWarning].filter((w): w is string => w !== undefined),
      sinks: { onCandleCommit: commitCandle },
    });
    if (feedAbortReason !== null) {
      result.summary.warnings.push(`run stopped by the feed-failure rule after ${a.maxTickFailures} consecutive failing boundaries (${feedAbortReason})`);
    }
    await runs.finishRun(id, d.now(), result.summary);
    // A run the feed-failure rule already marked `aborted`, with its reason, must keep that record:
    // overwriting it with `finished`/`signal` would erase the only trace of why it stopped.
    if (feedAbortReason === null) await runs.setStatus(id, 'finished', ac.signal.aborted ? 'signal' : 'feed ended');
    const run = await runs.getRun(id);
    // The REHEARSAL header comes from `run.rehearsal` inside printReport itself (finding F3), so
    // every path that reads this run back — including a later `report <run-id>` in a different
    // process — prints it. Finding C1: the headline is recomputed from every persisted row, across
    // every segment, rather than from this segment's `runs.summary` alone.
    if (run) printReport(run, await runs.listOrders(id), token.ticker, await runs.listEquity(id, new Date(0), d.now()));
    return { runId: id, summary: result.summary, status: feedAbortReason === null ? 'finished' : 'aborted' };
  } catch (err) {
    if (runId !== null) {
      await runs.setStatus(runId, 'aborted', (err as Error).message ?? String(err)).catch(() => {
        // intentional: original error wins; a failure recording the abort must not replace the real one
      });
    }
    throw err;
  }
}
