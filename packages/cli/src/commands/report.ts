import { createPool } from '@ctb/db';
import { PgRunRepo, type OrderRecord, type RunCoverage, type RunRow } from '@ctb/engine';
import { assumedVenuesTouched } from '@ctb/sim-executor';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

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

/** Operator output. Every number here comes from the runs row and its orders; the header is the provenance. */
export function printReport(run: RunRow, orders: Array<OrderRecord & { baseUnit: string }>, ticker: string): void {
  console.log(`\n=== run ${run.id} | ${run.mode} | ${run.strategyId} | ${ticker} | git ${run.gitSha}`);
  console.log(`data: ${run.dataSource} ${run.dataFrom.toISOString()} -> ${run.dataTo.toISOString()} | fill model: ${run.fillModel}`);
  console.log(`params: ${JSON.stringify(run.params)}`);
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

export async function reportCommand(log: Logger, args: string[]): Promise<void> {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id <= 0) throw new Error('usage: report <run-id>');
  const cfg = loadConfig(process.env, { blockfrost: false });
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const runs = new PgRunRepo(db);
    const run = await runs.getRun(id);
    if (!run) throw new Error(`no run ${id}`);
    const universe = await loadUniverse();
    const ticker = universe.tokens.find((t) => t.unit === run.baseUnit)?.ticker ?? run.baseUnit;
    printReport(run, await runs.listOrders(id), ticker);
  } finally {
    await db.end();
  }
}
