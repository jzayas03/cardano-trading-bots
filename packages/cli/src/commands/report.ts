import { createPool } from '@ctb/db';
import { PgRunRepo, type OrderRecord, type RunRow } from '@ctb/engine';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

const adaStr = (lovelace: string | bigint): string => (Number(BigInt(lovelace)) / 1_000_000).toFixed(6);

/** Operator output. Every number here comes from the runs row and its orders; the header is the provenance. */
export function printReport(run: RunRow, orders: Array<OrderRecord & { baseUnit: string }>, ticker: string): void {
  console.log(`\n=== run ${run.id} | ${run.mode} | ${run.strategyId} | ${ticker} | git ${run.gitSha}`);
  console.log(`data: ${run.dataSource} ${run.dataFrom.toISOString()} -> ${run.dataTo.toISOString()} | fill model: ${run.fillModel}`);
  console.log(`params: ${JSON.stringify(run.params)}`);
  if (!run.summary) { console.log('run has no summary (unfinished)'); return; }
  const s = run.summary;
  console.table([{ candles: s.candles, intents: s.intents, filled: s.filled, rejected: s.rejected, startAda: adaStr(s.startEquityLovelace), endAda: adaStr(s.endEquityLovelace),
    returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct, lovelaceFeesAda: adaStr(s.feesLovelace), poolFeesIn: s.poolFeesIn }]);
  if (Object.keys(s.rejectReasons).length) console.table(Object.entries(s.rejectReasons).map(([reason, count]) => ({ reason, count })));
  console.table(orders.slice(0, 50).map((o) => ({
    seq: o.seq, intent: o.tsIntent.toISOString(), side: o.intent.side, amountIn: o.intent.amountIn.toString(), status: o.result.status,
    fill: o.result.status === 'filled' ? o.result.tsFill.toISOString() : '-', amountOut: o.result.status === 'filled' ? o.result.amountOut.toString() : '-',
    slippageBps: o.result.status === 'filled' ? o.result.slippageBps : '-', reason: o.result.status === 'rejected' ? o.result.reason : o.intent.reason,
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
