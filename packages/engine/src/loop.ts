import { decimalToNumber } from '@ctb/candles';
import type { Logger } from '@ctb/collector/pure';
import { applyFill, equityLovelace } from './portfolio.js';
import type {
  Candle, EquityPoint, Executor, Intent, OrderRecord, Portfolio, RunCoverage, RunResult, RunSummaryStats, Strategy, WorkingPool,
} from './types.js';

export interface RunEngineDeps {
  feed: Iterable<Candle> | AsyncIterable<Candle>;
  strategy: Strategy;
  params?: Record<string, number>;
  executor: Executor;
  initial: Portfolio;
  decimals: number;
  log: Logger;
  historyLimit?: number;
  /** Bucket width the feed is supposed to have, for the expected-bucket count in coverage. */
  intervalSec?: number;
  /** The executor's stale-fill bound, so coverage can count how many gaps will reject a fill. */
  maxGapMs?: number;
  /**
   * Persistence hooks. Each is awaited before the loop moves on to the next candle, so a crash loses
   * at most the in-flight intents of the candle in progress — never a silently-unwritten order or
   * equity point from an earlier one.
   */
  sinks?: {
    onOrder?(o: OrderRecord): Promise<void>;
    onEquity?(e: EquityPoint): Promise<void>;
    onCandle?(c: Candle): Promise<void>;
    /**
     * One candle's whole settled batch, delivered once per candle after settle + observe and before
     * the strategy decides (finding I1b). The per-event sinks above fire independently, which means
     * a caller using them writes each candle's orders and its equity point in SEPARATE statements —
     * so a crash between them leaves a fill no equity point reflects, or an equity point for orders
     * that were never recorded. Handed the batch, a caller can write the whole candle in ONE
     * transaction and actually honour "every order and every equity point is persisted before the
     * loop moves to the next candle".
     *
     * `equity` is null on exactly one batch: the trailing one, emitted when intents left pending at
     * the end of the feed (or at an abort) settle to `rejected` with no new candle observed. It
     * exists so a caller that uses ONLY this sink never silently stops persisting those orders.
     */
    onCandleCommit?(batch: { candle: Candle; orders: OrderRecord[]; equity: EquityPoint | null }): Promise<void>;
  };
  /**
   * Keep the full `orders`/`equity` arrays in the returned `RunResult` (default `true`). A long-running
   * paper run passes `false` for bounded memory: the summary is still computed, incrementally, from the
   * same events the sinks receive — never from the (empty) arrays.
   */
  retain?: boolean;
  /** The first order emitted gets `startSeq + 1`; lets a resumed run continue numbering rather than restart at 1. */
  startSeq?: number;
  /**
   * Checked once per candle, after that candle is fully settled/observed/decided. When aborted, the
   * loop stops pulling more candles from the feed; any intents just decided (and therefore still
   * pending, never settled) are recorded as rejected `stopped` instead of being silently dropped.
   * Also checked once more after the feed loop ends, in case the abort happened while the feed's
   * iterator was blocked BETWEEN candles (e.g. a paper feed's inter-boundary sleep) rather than while
   * the loop body was running — see the note above `leftoverReason` below (finding F1).
   */
  signal?: AbortSignal;
  /**
   * Warnings to seed `summary.warnings` with, ahead of anything the loop itself appends (e.g. a
   * resumed run's "intents pending at the previous stop were lost" notice). Given in order.
   */
  initialWarnings?: string[];
  /**
   * Candles this run already lived through, handed back so a RESUMED run's indicators start warm
   * instead of blind (finding I6): without them a strategy needing N candles of warmup could not
   * emit an intent for the first N boundaries after every restart, which on a 5-minute interval
   * with `slow=48` is four hours of a process that looks live and structurally cannot trade.
   *
   * They are context, never observations. They fill `history`/`closes` and nothing else: no equity
   * point, no `onCandle`/commit sink, no decision, and no coverage — coverage must keep describing
   * the candles this segment actually consumed from the feed, or a resumed run would double-count
   * its own history. Given oldest first; trimmed to `historyLimit` like any other candle.
   */
  primeHistory?: Candle[];
}

const DEFAULT_INTERVAL_SEC = 300;
const DEFAULT_MAX_GAP_MS = 15 * 60_000;

/**
 * Accumulates `RunSummaryStats` from a stream of orders and equity points, without ever holding the
 * full history — so a bounded-memory run (`retain: false`) and a fully-retained one compute the exact
 * same numbers from the exact same per-event math, and cannot drift apart (the "identical summary"
 * test pins this). `summarize()` below is a thin wrapper over the same class, for the same reason.
 */
export class Summarizer {
  private startEquity: bigint | null = null;
  private endEquity = 0n;
  private peak = 0n;
  private maxDd = 0;
  private fees = 0n;
  private poolFees = 0n;
  private poolFeesLovelace = 0n;
  private poolFeesBase = 0n;
  private filled = 0;
  private intents = 0;
  private readonly rejectReasons: Record<string, number> = {};

  addOrder(o: OrderRecord): void {
    this.intents++;
    if (o.result.status === 'filled') {
      this.filled++;
      this.fees += o.result.batcherFeeLovelace + o.result.networkFeeLovelace;
      this.poolFees += o.result.poolFeeIn;
      // Split by side: the fee is charged on the INPUT, which is lovelace buying and base selling.
      if (o.intent.side === 'buy') this.poolFeesLovelace += o.result.poolFeeIn;
      else this.poolFeesBase += o.result.poolFeeIn;
    } else {
      this.rejectReasons[o.result.reason] = (this.rejectReasons[o.result.reason] ?? 0) + 1;
    }
  }

  addEquity(e: EquityPoint): void {
    this.startEquity ??= e.equityLovelace;
    this.endEquity = e.equityLovelace;
    if (e.equityLovelace > this.peak) this.peak = e.equityLovelace;
    if (this.peak > 0n) {
      const dd = Number((this.peak - e.equityLovelace) * 10_000n / this.peak) / 100;
      if (dd > this.maxDd) this.maxDd = dd;
    }
  }

  /** Number of orders ingested so far, regardless of whether the caller is retaining them. */
  get filledCount(): number {
    return this.filled;
  }
  /** Reject reasons, most frequent first, as `reason xN`. */
  topRejectReasons(n: number): string[] {
    return Object.entries(this.rejectReasons).sort((a, b) => b[1] - a[1]).slice(0, n).map(([r, k]) => `${r} x${k}`);
  }
  get orderCount(): number {
    return this.intents;
  }

  finish(coverage: RunCoverage, warnings: string[]): RunSummaryStats {
    const start = this.startEquity ?? 0n;
    const end = this.endEquity;
    return {
      candles: coverage.candles, intents: this.intents, filled: this.filled, rejected: this.intents - this.filled,
      startEquityLovelace: start.toString(), endEquityLovelace: end.toString(),
      returnPct: start > 0n ? Number((end - start) * 10_000n / start) / 100 : 0,
      maxDrawdownPct: this.maxDd, feesLovelace: this.fees.toString(), poolFeesIn: this.poolFees.toString(),
      poolFeesInLovelace: this.poolFeesLovelace.toString(), poolFeesInBase: this.poolFeesBase.toString(),
      rejectReasons: this.rejectReasons, coverage, warnings,
    };
  }
}

/** One loop for backtest and paper: intents from candle t are filled against candle t+1. */
export async function runEngine(d: RunEngineDeps): Promise<RunResult> {
  const params = { ...d.strategy.defaultParams, ...(d.params ?? {}) };
  // The warmup that matters is the one these params imply, not the one the defaults imply: a run
  // with --param slow=5000 needs 5001 candles and must say so rather than trade nothing (finding I5).
  const warmup = d.strategy.warmupFor(params);
  const historyLimit = d.historyLimit ?? Math.max(warmup * 4, 64);
  if (historyLimit < warmup) {
    throw new Error(`historyLimit ${historyLimit} is below strategy ${d.strategy.id} warmup ${warmup} for these params: it could never emit an intent`);
  }
  const intervalMs = (d.intervalSec ?? DEFAULT_INTERVAL_SEC) * 1000;
  const maxGapMs = d.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const retain = d.retain ?? true;
  const startSeq = d.startSeq ?? 0;
  const history: Candle[] = [];
  const closes: number[] = [];
  const orders: OrderRecord[] = [];
  const equity: EquityPoint[] = [];
  const summarizer = new Summarizer();
  let portfolio: Portfolio = { ...d.initial };
  let pending: Array<{ tsIntent: Date; at: Candle; intent: Intent }> = [];
  let seq = startSeq;
  let candles = 0;
  let firstTs: Date | null = null;
  let lastTs: Date | null = null;
  /** The most recent candle consumed, so the trailing leftover batch can name the candle its
   * intents were decided on rather than inventing one. */
  let lastCandle: Candle | null = null;
  let widestGapMs = 0;
  let gapsOverBound = 0;
  let aborted = false;
  // Pools this run's own consumed candles actually came from (finding: the deepest-pool candle
  // builder silently splices series across venues when one drops out). Seeded empty, never from
  // `primeHistory` — same rule as `candles`/`firstTs`/`lastTs` above: a resumed segment counts only
  // what IT consumed.
  const poolsSeen = new Set<string>();

  // Finding I6: seed the indicator window BEFORE the feed starts. Deliberately not touching
  // `candles`/`firstTs`/`lastTs`/`summarizer` — see `primeHistory`'s doc comment.
  for (const primed of d.primeHistory ?? []) {
    history.push(primed);
    closes.push(decimalToNumber(primed.close));
    if (history.length > historyLimit) { history.shift(); closes.shift(); }
  }

  // This candle's settled orders, handed to `onCandleCommit` as one batch. Reset per candle, so it
  // stays bounded even on a `retain: false` run that keeps nothing else.
  let settledThisCandle: OrderRecord[] = [];

  const recordOrder = async (order: OrderRecord): Promise<void> => {
    if (retain) orders.push(order);
    summarizer.addOrder(order);
    settledThisCandle.push(order);
    await d.sinks?.onOrder?.(order);
  };

  for await (const candle of d.feed as AsyncIterable<Candle>) {
    candles++;
    if (lastTs !== null) {
      const gap = candle.tickTs.getTime() - lastTs.getTime();
      if (gap > widestGapMs) widestGapMs = gap;
      if (gap > maxGapMs) gapsOverBound++;
    }
    firstTs ??= candle.tickTs;
    lastTs = candle.tickTs;
    lastCandle = candle;
    if (candle.poolId !== null) poolsSeen.add(candle.poolId);
    // 1. settle what was decided on the previous candle. Intents decided together (same candle) fill
    // in order against a pool that depletes as they go: each fill's `poolAfter` becomes the `working`
    // reserves the next one in the batch trades against, instead of every one hitting the same quote.
    let working: WorkingPool | undefined;
    settledThisCandle = [];
    for (const p of pending) {
      seq++;
      const result = d.executor.fill(p.intent, p.at, candle, portfolio, working);
      if (result.status === 'filled') {
        portfolio = applyFill(portfolio, result, p.intent.side);
        if (result.poolAfter) working = result.poolAfter;
      }
      await recordOrder({ seq, tsIntent: p.tsIntent, intent: p.intent, result });
    }
    pending = [];
    // 2. observe
    history.push(candle);
    closes.push(decimalToNumber(candle.close));
    if (history.length > historyLimit) { history.shift(); closes.shift(); }
    await d.sinks?.onCandle?.(candle);
    const equityPoint: EquityPoint = {
      tickTs: candle.tickTs, cashLovelace: portfolio.cashLovelace, positionBase: portfolio.positionBase,
      equityLovelace: equityLovelace(portfolio, candle.close, d.decimals),
      equityExecutableLovelace: d.executor.markToMarket(portfolio, candle),
      price: candle.close,
    };
    if (retain) equity.push(equityPoint);
    summarizer.addEquity(equityPoint);
    await d.sinks?.onEquity?.(equityPoint);
    // 2b. commit this candle as one batch: what settled on it, plus the equity point it produced
    // (finding I1b). Before the decision below, so nothing decided on THIS candle can leak into a
    // batch labelled with it — a decision settles on the next candle and is committed there.
    await d.sinks?.onCandleCommit?.({ candle, orders: settledThisCandle, equity: equityPoint });
    // 3. decide
    if (history.length >= warmup) {
      const intents = d.strategy.onCandle({ candle, history: [...history], closes: [...closes], portfolio, params });
      for (const intent of intents) {
        if (intent.amountIn <= 0n) throw new Error(`strategy ${d.strategy.id} emitted a non-positive amountIn`);
        pending.push({ tsIntent: candle.tickTs, at: candle, intent });
      }
    }
    if (d.signal?.aborted) { aborted = true; break; }
  }
  // If the signal aborted while the feed's async iterator was blocked BETWEEN candles (e.g. paper's
  // inter-boundary sleep), `sleep()` resolves on abort and the generator returns without yielding
  // another candle: the `for await` above then ends via a normal `{ done: true }` completion, never
  // re-entering the loop body where the in-loop abort check lives. Without this, `aborted` would stay
  // false here and any leftover pending intent would be mislabeled `no t+1 candle` instead of the
  // correct `stopped` (finding F1).
  if (d.signal?.aborted) aborted = true;
  // Whatever was decided on the last candle we actually processed never got a chance to settle: on a
  // normal end of feed there was no t+1 candle to fill against; on an abort we stopped on purpose
  // before pulling one. Either way the intent is not silently dropped — it is recorded as rejected.
  const leftoverReason = aborted ? 'stopped' : 'no t+1 candle';
  settledThisCandle = [];
  for (const p of pending) {
    seq++;
    await recordOrder({ seq, tsIntent: p.tsIntent, intent: p.intent, result: { status: 'rejected', reason: leftoverReason } });
  }
  // The leftovers observed no candle of their own, so they need a trailing batch with no equity
  // point — otherwise a caller wired only to `onCandleCommit` would silently stop persisting them,
  // which is exactly the "recorded as rejected, never dropped" guarantee above.
  if (settledThisCandle.length > 0 && lastCandle !== null) {
    await d.sinks?.onCandleCommit?.({ candle: lastCandle, orders: settledThisCandle, equity: null });
  }
  const coverage: RunCoverage = {
    candles,
    first: firstTs?.toISOString() ?? null,
    last: lastTs?.toISOString() ?? null,
    expectedBuckets: firstTs && lastTs ? Math.floor((lastTs.getTime() - firstTs.getTime()) / intervalMs) + 1 : 0,
    maxGapMs: widestGapMs,
    gapsOverBound,
    distinctPools: poolsSeen.size,
  };
  const warnings: string[] = [...(d.initialWarnings ?? [])];
  if (poolsSeen.size > 1) {
    // Naming which is free: the pool ids were already in hand from the candles above. `dex:identifier`
    // (see `poolIdOf`), sorted so the message is stable across runs over the identical data.
    const pools = [...poolsSeen].sort();
    const warning = `candle series spans ${poolsSeen.size} pools: ${pools.join(', ')}`;
    warnings.push(warning);
    d.log.warn({ strategy: d.strategy.id, pools }, 'candle series spans multiple pools');
  }
  if (summarizer.orderCount === 0) {
    // A run that emitted nothing is indistinguishable from a run that found no signal unless someone
    // says which it was. Params, warmup, and candle count are what tell them apart (finding I5).
    const warning = `strategy ${d.strategy.id} produced zero intents over ${candles} candles (warmup ${warmup}, params ${JSON.stringify(params)})`;
    warnings.push(warning);
    d.log.warn({ strategy: d.strategy.id, candles, warmup, params }, 'run produced zero intents');
  } else if (summarizer.filledCount === 0) {
    // The other way a run can be a non-event: it kept asking and the executor kept saying no. A
    // buy-and-hold at fraction 1 did this 4,969 times over one window (insufficient cash: the fees
    // the strategy cannot see) and reported a clean 0% return with nothing flagged.
    const warning = `strategy ${d.strategy.id} emitted ${summarizer.orderCount} intents and none filled (${summarizer.topRejectReasons(3).join(', ')})`;
    warnings.push(warning);
    d.log.warn({ strategy: d.strategy.id, intents: summarizer.orderCount, reasons: summarizer.topRejectReasons(3) }, 'run never filled');
  }
  const summary = summarizer.finish(coverage, warnings);
  d.log.info({ strategy: d.strategy.id, ...summary }, 'engine run finished');
  return { orders, equity, final: portfolio, summary };
}

export function summarize(orders: OrderRecord[], equity: EquityPoint[], coverage: RunCoverage, warnings: string[] = []): RunSummaryStats {
  const s = new Summarizer();
  for (const o of orders) s.addOrder(o);
  for (const e of equity) s.addEquity(e);
  return s.finish(coverage, warnings);
}
