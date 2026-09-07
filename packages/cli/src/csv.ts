import type { EquityPoint, OrderRecord, RunRow } from '@ctb/engine';

/**
 * RFC 4180 quoting: a field holding a comma, a quote, or a line break is wrapped in quotes with inner
 * quotes doubled. Everything else is written bare. Order reasons carry commas and `->` freely
 * (`rsi back above 30 (0.0 -> 50.0) period=2`), so this is not optional.
 */
export function csvField(v: string | number | bigint | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : v.toString();
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (cells: Array<string | number | bigint | null | undefined>): string => cells.map(csvField).join(',');

export const ORDER_COLUMNS = [
  'seq', 'ts_intent', 'side', 'amount_in', 'intent_reason', 'status', 'ts_fill', 'pool_id', 'unit_in', 'unit_out', 'amount_out',
  'mid_price', 'fill_price', 'pool_fee_in', 'batcher_fee_lovelace', 'network_fee_lovelace', 'slippage_bps', 'price_impact_bps', 'reject_reason',
] as const;

/** Lovelace and base amounts as integers, prices as the stored decimal strings, timestamps ISO. One row per persisted order. */
export function ordersCsv(orders: OrderRecord[]): string {
  const lines = [ORDER_COLUMNS.join(',')];
  for (const o of orders) {
    const r = o.result;
    lines.push(r.status === 'filled'
      ? row([o.seq, o.tsIntent.toISOString(), o.intent.side, o.intent.amountIn, o.intent.reason, 'filled', r.tsFill.toISOString(), r.poolId, r.unitIn, r.unitOut, r.amountOut,
        r.midPrice, r.fillPrice, r.poolFeeIn, r.batcherFeeLovelace, r.networkFeeLovelace, r.slippageBps, r.priceImpactBps, null])
      : row([o.seq, o.tsIntent.toISOString(), o.intent.side, o.intent.amountIn, o.intent.reason, 'rejected', null, null, null, null, null,
        null, null, null, null, null, null, null, r.reason]));
  }
  return lines.join('\n') + '\n';
}

export const EQUITY_COLUMNS = ['tick_ts', 'cash_lovelace', 'position_base', 'equity_lovelace', 'equity_executable_lovelace', 'price'] as const;

/** One row per persisted equity point. `equity_executable_lovelace` is empty where the executor could not price the position. */
export function equityCsv(points: EquityPoint[]): string {
  const lines = [EQUITY_COLUMNS.join(',')];
  for (const p of points) lines.push(row([p.tickTs.toISOString(), p.cashLovelace, p.positionBase, p.equityLovelace, p.equityExecutableLovelace, p.price]));
  return lines.join('\n') + '\n';
}

/**
 * A rehearsal run's files carry REHEARSAL in the NAME. A comment line inside the CSV would break
 * every plotting tool, and a synthetic-data marker that only lives in stdout is gone by the time the
 * file is opened (global constraint: synthetic data can never be mistaken for real).
 */
export function csvFileNames(run: Pick<RunRow, 'id' | 'rehearsal'>): { orders: string; equity: string } {
  const stem = `run-${run.id}${run.rehearsal ? '-REHEARSAL' : ''}`;
  return { orders: `${stem}-orders.csv`, equity: `${stem}-equity.csv` };
}
