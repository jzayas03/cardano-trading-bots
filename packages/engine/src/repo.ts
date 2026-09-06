import { execFileSync } from 'node:child_process';
import type { Db } from '@ctb/db';
import type { OrderRecord, RunSummaryStats } from './types.js';

export interface NewRun {
  mode: 'backtest' | 'paper'; strategyId: string; params: Record<string, unknown>; gitSha: string; baseUnit: string;
  dataSource: 'candles' | 'candles_external'; fillModel: 'cpmm_observed' | 'cpmm_synthetic_depth'; dataFrom: Date; dataTo: Date;
}
export interface RunRow extends NewRun { id: number; createdAt: Date; finishedAt: Date | null; summary: RunSummaryStats | null }

export interface RunRepo {
  createRun(r: NewRun): Promise<number>;
  finishRun(id: number, finishedAt: Date, summary: RunSummaryStats): Promise<void>;
  getRun(id: number): Promise<RunRow | null>;
  insertOrders(runId: number, baseUnit: string, orders: OrderRecord[]): Promise<number>;
  listOrders(runId: number): Promise<Array<OrderRecord & { baseUnit: string }>>;
}

/** Returns the current commit sha, or 'unknown' when run outside a git checkout (e.g. a packaged deploy). */
export function gitShaOrUnknown(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // intentional: a run outside a git checkout is still a run; the caller logs that provenance is missing
    return 'unknown';
  }
}

/** Placeholders per paper_orders row: run_id, seq, ts_intent, ts_fill, base_unit, pool_id, side, unit_in, amount_in,
 * unit_out, amount_out, mid_price, fill_price, pool_fee_in, batcher_fee_lovelace, network_fee_lovelace, slippage_bps,
 * status, reject_reason, reason — 20 columns, matching the INSERT column list below. */
const ORDER_PARAMS = 20;

export class PgRunRepo implements RunRepo {
  constructor(private readonly db: Db) {}

  async createRun(r: NewRun): Promise<number> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO runs (mode, strategy_id, params, git_sha, base_unit, data_source, fill_model, data_from, data_to)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [r.mode, r.strategyId, JSON.stringify(r.params), r.gitSha, r.baseUnit, r.dataSource, r.fillModel, r.dataFrom, r.dataTo]);
    const id = res.rows[0]?.id;
    if (id === undefined) throw new Error('createRun returned no id');
    return Number(id);
  }

  async finishRun(id: number, finishedAt: Date, summary: RunSummaryStats): Promise<void> {
    await this.db.query('UPDATE runs SET finished_at = $2, summary = $3::jsonb WHERE id = $1', [id, finishedAt, JSON.stringify(summary)]);
  }

  async getRun(id: number): Promise<RunRow | null> {
    const res = await this.db.query<{
      id: string; mode: 'backtest' | 'paper'; strategy_id: string; params: Record<string, unknown>; git_sha: string; base_unit: string;
      data_source: 'candles' | 'candles_external'; fill_model: 'cpmm_observed' | 'cpmm_synthetic_depth'; data_from: Date; data_to: Date; created_at: Date; finished_at: Date | null; summary: RunSummaryStats | null;
    }>('SELECT * FROM runs WHERE id = $1', [id]);
    const r = res.rows[0];
    if (!r) return null;
    return { id: Number(r.id), mode: r.mode, strategyId: r.strategy_id, params: r.params, gitSha: r.git_sha, baseUnit: r.base_unit, dataSource: r.data_source,
      fillModel: r.fill_model, dataFrom: r.data_from, dataTo: r.data_to, createdAt: r.created_at, finishedAt: r.finished_at, summary: r.summary };
  }

  async insertOrders(runId: number, baseUnit: string, orders: OrderRecord[]): Promise<number> {
    if (orders.length === 0) return 0;
    const values: unknown[] = [];
    const tuples = orders.map((o, i) => {
      const f = o.result.status === 'filled' ? o.result : null;
      values.push(
        runId, o.seq, o.tsIntent, f?.tsFill ?? null, baseUnit, f?.poolId ?? null, o.intent.side,
        f?.unitIn ?? (o.intent.side === 'buy' ? 'lovelace' : baseUnit), o.intent.amountIn.toString(),
        f?.unitOut ?? null, f ? f.amountOut.toString() : null, f?.midPrice ?? null, f?.fillPrice ?? null,
        f ? f.poolFeeIn.toString() : null, f ? f.batcherFeeLovelace.toString() : null, f ? f.networkFeeLovelace.toString() : null,
        f?.slippageBps ?? null, o.result.status, o.result.status === 'rejected' ? o.result.reason : null, o.intent.reason,
      );
      return `(${Array.from({ length: ORDER_PARAMS }, (_, k) => `$${i * ORDER_PARAMS + k + 1}`).join(', ')})`;
    });
    const res = await this.db.query(
      `INSERT INTO paper_orders (run_id, seq, ts_intent, ts_fill, base_unit, pool_id, side, unit_in, amount_in, unit_out, amount_out, mid_price, fill_price,
         pool_fee_in, batcher_fee_lovelace, network_fee_lovelace, slippage_bps, status, reject_reason, reason) VALUES ${tuples.join(', ')}`,
      values);
    return res.rowCount ?? 0;
  }

  async listOrders(runId: number): Promise<Array<OrderRecord & { baseUnit: string }>> {
    const res = await this.db.query<{
      seq: number; ts_intent: Date; ts_fill: Date | null; base_unit: string; pool_id: string | null; side: 'buy' | 'sell'; unit_in: string; amount_in: string; unit_out: string | null;
      amount_out: string | null; mid_price: string | null; fill_price: string | null; pool_fee_in: string | null; batcher_fee_lovelace: string | null; network_fee_lovelace: string | null;
      slippage_bps: number | null; status: 'filled' | 'rejected'; reject_reason: string | null; reason: string;
    }>('SELECT * FROM paper_orders WHERE run_id = $1 ORDER BY seq', [runId]);
    return res.rows.map((r) => ({
      seq: r.seq, tsIntent: r.ts_intent, baseUnit: r.base_unit,
      intent: { side: r.side, amountIn: BigInt(r.amount_in), reason: r.reason },
      result: r.status === 'filled'
        ? { status: 'filled', poolId: r.pool_id ?? '', unitIn: r.unit_in, amountIn: BigInt(r.amount_in), unitOut: r.unit_out ?? '', amountOut: BigInt(r.amount_out ?? '0'),
            midPrice: r.mid_price ?? '0', fillPrice: r.fill_price ?? '0', poolFeeIn: BigInt(r.pool_fee_in ?? '0'), batcherFeeLovelace: BigInt(r.batcher_fee_lovelace ?? '0'),
            networkFeeLovelace: BigInt(r.network_fee_lovelace ?? '0'), slippageBps: r.slippage_bps ?? 0, tsFill: r.ts_fill ?? r.ts_intent }
        : { status: 'rejected', reason: r.reject_reason ?? 'unknown' },
    }));
  }
}
