import { execFileSync } from 'node:child_process';
import { withTransaction, type Db, type Queryable } from '@ctb/db';
import { INSERT_CHUNK_ROWS } from '@ctb/candles';
import type { EquityPoint, OrderRecord, RunSummaryStats } from './types.js';

export interface NewRun {
  mode: 'backtest' | 'paper'; strategyId: string; params: Record<string, unknown>; gitSha: string; baseUnit: string;
  dataSource: 'candles' | 'candles_external'; fillModel: 'cpmm_observed' | 'cpmm_synthetic_depth'; dataFrom: Date; dataTo: Date;
}
export interface RunRow extends NewRun {
  id: number; createdAt: Date; finishedAt: Date | null; summary: RunSummaryStats | null;
  status: 'running' | 'finished' | 'aborted'; heartbeatAt: Date | null; lastTickTs: Date | null; stopReason: string | null; rehearsal: boolean;
}

export interface RunningRun {
  id: number; strategyId: string; baseUnit: string; rehearsal: boolean; heartbeatAt: Date | null; lastTickTs: Date | null; createdAt: Date;
}

export interface RunRepo {
  /** Backtests keep the default `status: 'finished'`, written up front and closed by `finishRun`. Paper runs pass `status: 'running'`. */
  createRun(r: NewRun & { rehearsal?: boolean; status?: 'running' | 'finished' }): Promise<number>;
  finishRun(id: number, finishedAt: Date, summary: RunSummaryStats): Promise<void>;
  getRun(id: number): Promise<RunRow | null>;
  insertOrders(runId: number, baseUnit: string, orders: OrderRecord[]): Promise<number>;
  listOrders(runId: number): Promise<Array<OrderRecord & { baseUnit: string }>>;
  /** Chunked at INSERT_CHUNK_ROWS; ON CONFLICT DO NOTHING so a resumed run replaying a tick doesn't duplicate. */
  insertEquity(runId: number, points: EquityPoint[]): Promise<number>;
  lastEquity(runId: number): Promise<EquityPoint | null>;
  listEquity(runId: number, from: Date, to: Date): Promise<EquityPoint[]>;
  /** 0 when the run has recorded no orders yet — the next seq a resumed loop should use is this + 1. */
  lastOrderSeq(runId: number): Promise<number>;
  listOrdersBetween(runId: number, from: Date, to: Date): Promise<Array<OrderRecord & { baseUnit: string }>>;
  heartbeat(runId: number, at: Date, lastTickTs: Date | null): Promise<void>;
  /** Leaving 'running' sets finished_at (once); re-entering 'running' on resume clears it. */
  setStatus(runId: number, status: 'running' | 'finished' | 'aborted', reason: string | null): Promise<void>;
  listRunning(): Promise<RunningRun[]>;
  /** Records a resume as an ISO timestamp appended to params.resumes, so a run's params carry every restart it survived. */
  appendResume(runId: number, at: Date): Promise<void>;
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
 * price_impact_bps, status, reject_reason, reason — 21 columns, matching the INSERT column list below. */
const ORDER_PARAMS = 21;

/**
 * 21 parameters per order means a single multi-row INSERT hit Postgres's 65535-parameter Bind cap at
 * 3120 orders — reachable in one long backtest. Chunk and wrap in one transaction (finding C1).
 */
const ORDER_CHUNK_ROWS = 1000;

export class PgRunRepo implements RunRepo {
  private readonly q: Queryable;

  /** `q` is passed only when binding this repo to one checked-out client inside a transaction. */
  constructor(private readonly db: Db, q?: Queryable) {
    this.q = q ?? db;
  }

  async createRun(r: NewRun & { rehearsal?: boolean; status?: 'running' | 'finished' }): Promise<number> {
    const res = await this.q.query<{ id: string }>(
      `INSERT INTO runs (mode, strategy_id, params, git_sha, base_unit, data_source, fill_model, data_from, data_to, status, rehearsal)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [r.mode, r.strategyId, JSON.stringify(r.params), r.gitSha, r.baseUnit, r.dataSource, r.fillModel, r.dataFrom, r.dataTo, r.status ?? 'finished', r.rehearsal ?? false]);
    const id = res.rows[0]?.id;
    if (id === undefined) throw new Error('createRun returned no id');
    return Number(id);
  }

  async finishRun(id: number, finishedAt: Date, summary: RunSummaryStats): Promise<void> {
    await this.q.query('UPDATE runs SET finished_at = $2, summary = $3::jsonb WHERE id = $1', [id, finishedAt, JSON.stringify(summary)]);
  }

  async getRun(id: number): Promise<RunRow | null> {
    const res = await this.q.query<{
      id: string; mode: 'backtest' | 'paper'; strategy_id: string; params: Record<string, unknown>; git_sha: string; base_unit: string;
      data_source: 'candles' | 'candles_external'; fill_model: 'cpmm_observed' | 'cpmm_synthetic_depth'; data_from: Date; data_to: Date; created_at: Date; finished_at: Date | null; summary: RunSummaryStats | null;
      status: 'running' | 'finished' | 'aborted'; heartbeat_at: Date | null; last_tick_ts: Date | null; stop_reason: string | null; rehearsal: boolean;
    }>('SELECT * FROM runs WHERE id = $1', [id]);
    const r = res.rows[0];
    if (!r) return null;
    return { id: Number(r.id), mode: r.mode, strategyId: r.strategy_id, params: r.params, gitSha: r.git_sha, baseUnit: r.base_unit, dataSource: r.data_source,
      fillModel: r.fill_model, dataFrom: r.data_from, dataTo: r.data_to, createdAt: r.created_at, finishedAt: r.finished_at, summary: r.summary,
      status: r.status, heartbeatAt: r.heartbeat_at, lastTickTs: r.last_tick_ts, stopReason: r.stop_reason, rehearsal: r.rehearsal };
  }

  async insertOrders(runId: number, baseUnit: string, orders: OrderRecord[]): Promise<number> {
    if (orders.length === 0) return 0;
    const run = async (q: Queryable): Promise<number> => {
      let inserted = 0;
      for (let i = 0; i < orders.length; i += ORDER_CHUNK_ROWS) {
        inserted += await insertOrderChunk(q, runId, baseUnit, orders.slice(i, i + ORDER_CHUNK_ROWS));
      }
      return inserted;
    };
    return this.q === this.db ? withTransaction(this.db, run) : run(this.q);
  }

  async listOrders(runId: number): Promise<Array<OrderRecord & { baseUnit: string }>> {
    const res = await this.q.query<OrderRow>('SELECT * FROM paper_orders WHERE run_id = $1 ORDER BY seq', [runId]);
    return res.rows.map(mapOrderRow);
  }

  async listOrdersBetween(runId: number, from: Date, to: Date): Promise<Array<OrderRecord & { baseUnit: string }>> {
    const res = await this.q.query<OrderRow>(
      'SELECT * FROM paper_orders WHERE run_id = $1 AND ts_intent BETWEEN $2 AND $3 ORDER BY seq', [runId, from, to]);
    return res.rows.map(mapOrderRow);
  }

  async lastOrderSeq(runId: number): Promise<number> {
    const res = await this.q.query<{ seq: number }>('SELECT coalesce(max(seq), 0) AS seq FROM paper_orders WHERE run_id = $1', [runId]);
    return res.rows[0]?.seq ?? 0;
  }

  async insertEquity(runId: number, points: EquityPoint[]): Promise<number> {
    let n = 0;
    for (let i = 0; i < points.length; i += INSERT_CHUNK_ROWS) {
      const chunk = points.slice(i, i + INSERT_CHUNK_ROWS);
      const values: unknown[] = [];
      const tuples = chunk.map((p, j) => {
        values.push(runId, p.tickTs, p.cashLovelace.toString(), p.positionBase.toString(), p.equityLovelace.toString(),
          p.equityExecutableLovelace === null ? null : p.equityExecutableLovelace.toString(), p.price);
        return `(${Array.from({ length: EQUITY_PARAMS }, (_, k) => `$${j * EQUITY_PARAMS + k + 1}`).join(', ')})`;
      });
      const r = await this.q.query(
        `INSERT INTO run_equity (run_id, tick_ts, cash_lovelace, position_base, equity_lovelace, equity_executable_lovelace, price)
         VALUES ${tuples.join(', ')} ON CONFLICT (run_id, tick_ts) DO NOTHING`, values);
      n += r.rowCount ?? 0;
    }
    return n;
  }

  async lastEquity(runId: number): Promise<EquityPoint | null> {
    const res = await this.q.query<EquityRow>(
      `SELECT tick_ts, cash_lovelace, position_base, equity_lovelace, equity_executable_lovelace, price
       FROM run_equity WHERE run_id = $1 ORDER BY tick_ts DESC LIMIT 1`, [runId]);
    const r = res.rows[0];
    return r ? mapEquityRow(r) : null;
  }

  async listEquity(runId: number, from: Date, to: Date): Promise<EquityPoint[]> {
    const res = await this.q.query<EquityRow>(
      `SELECT tick_ts, cash_lovelace, position_base, equity_lovelace, equity_executable_lovelace, price
       FROM run_equity WHERE run_id = $1 AND tick_ts BETWEEN $2 AND $3 ORDER BY tick_ts`, [runId, from, to]);
    return res.rows.map(mapEquityRow);
  }

  async heartbeat(runId: number, at: Date, lastTickTs: Date | null): Promise<void> {
    await this.q.query('UPDATE runs SET heartbeat_at = $2, last_tick_ts = coalesce($3, last_tick_ts) WHERE id = $1', [runId, at, lastTickTs]);
  }

  async setStatus(runId: number, status: 'running' | 'finished' | 'aborted', reason: string | null): Promise<void> {
    await this.q.query(
      `UPDATE runs SET status = $2, stop_reason = $3,
         finished_at = CASE WHEN $2 = 'running' THEN NULL ELSE coalesce(finished_at, now()) END
       WHERE id = $1`, [runId, status, reason]);
  }

  async listRunning(): Promise<RunningRun[]> {
    const res = await this.q.query<{ id: string; strategy_id: string; base_unit: string; rehearsal: boolean; heartbeat_at: Date | null; last_tick_ts: Date | null; created_at: Date }>(
      `SELECT id, strategy_id, base_unit, rehearsal, heartbeat_at, last_tick_ts, created_at FROM runs WHERE status = 'running' ORDER BY id`);
    return res.rows.map((r) => ({
      id: Number(r.id), strategyId: r.strategy_id, baseUnit: r.base_unit, rehearsal: r.rehearsal,
      heartbeatAt: r.heartbeat_at, lastTickTs: r.last_tick_ts, createdAt: r.created_at,
    }));
  }

  async appendResume(runId: number, at: Date): Promise<void> {
    await this.q.query(
      `UPDATE runs SET params = jsonb_set(params, '{resumes}', coalesce(params->'resumes', '[]'::jsonb) || to_jsonb($2::text)) WHERE id = $1`,
      [runId, at.toISOString()]);
  }
}

/** Placeholders per run_equity row: run_id, tick_ts, cash_lovelace, position_base, equity_lovelace, equity_executable_lovelace, price. */
const EQUITY_PARAMS = 7;

interface EquityRow {
  tick_ts: Date; cash_lovelace: string; position_base: string; equity_lovelace: string; equity_executable_lovelace: string | null; price: string;
}

function mapEquityRow(r: EquityRow): EquityPoint {
  return {
    tickTs: r.tick_ts, cashLovelace: BigInt(r.cash_lovelace), positionBase: BigInt(r.position_base), equityLovelace: BigInt(r.equity_lovelace),
    equityExecutableLovelace: r.equity_executable_lovelace === null ? null : BigInt(r.equity_executable_lovelace), price: r.price,
  };
}

interface OrderRow {
  seq: number; ts_intent: Date; ts_fill: Date | null; base_unit: string; pool_id: string | null; side: 'buy' | 'sell'; unit_in: string; amount_in: string; unit_out: string | null;
  amount_out: string | null; mid_price: string | null; fill_price: string | null; pool_fee_in: string | null; batcher_fee_lovelace: string | null; network_fee_lovelace: string | null;
  slippage_bps: number | null; price_impact_bps: number | null; status: 'filled' | 'rejected'; reject_reason: string | null; reason: string;
}

function mapOrderRow(r: OrderRow): OrderRecord & { baseUnit: string } {
  return {
    seq: r.seq, tsIntent: r.ts_intent, baseUnit: r.base_unit,
    intent: { side: r.side, amountIn: BigInt(r.amount_in), reason: r.reason },
    result: r.status === 'filled'
      ? { status: 'filled', poolId: r.pool_id ?? '', unitIn: r.unit_in, amountIn: BigInt(r.amount_in), unitOut: r.unit_out ?? '', amountOut: BigInt(r.amount_out ?? '0'),
          midPrice: r.mid_price ?? '0', fillPrice: r.fill_price ?? '0', poolFeeIn: BigInt(r.pool_fee_in ?? '0'), batcherFeeLovelace: BigInt(r.batcher_fee_lovelace ?? '0'),
          networkFeeLovelace: BigInt(r.network_fee_lovelace ?? '0'), slippageBps: r.slippage_bps ?? 0, priceImpactBps: r.price_impact_bps ?? 0,
          // poolAfter is intra-run working state, not a persisted column: a fill read back from
          // paper_orders has no reserves-after-this-fill to report.
          poolAfter: null, tsFill: r.ts_fill ?? r.ts_intent }
      : { status: 'rejected', reason: r.reject_reason ?? 'unknown' },
  };
}

async function insertOrderChunk(q: Queryable, runId: number, baseUnit: string, orders: OrderRecord[]): Promise<number> {
  const values: unknown[] = [];
  const tuples = orders.map((o, i) => {
    const f = o.result.status === 'filled' ? o.result : null;
    values.push(
      runId, o.seq, o.tsIntent, f?.tsFill ?? null, baseUnit, f?.poolId ?? null, o.intent.side,
      f?.unitIn ?? (o.intent.side === 'buy' ? 'lovelace' : baseUnit), o.intent.amountIn.toString(),
      f?.unitOut ?? null, f ? f.amountOut.toString() : null, f?.midPrice ?? null, f?.fillPrice ?? null,
      f ? f.poolFeeIn.toString() : null, f ? f.batcherFeeLovelace.toString() : null, f ? f.networkFeeLovelace.toString() : null,
      f?.slippageBps ?? null, f?.priceImpactBps ?? null, o.result.status, o.result.status === 'rejected' ? o.result.reason : null, o.intent.reason,
    );
    return `(${Array.from({ length: ORDER_PARAMS }, (_, k) => `$${i * ORDER_PARAMS + k + 1}`).join(', ')})`;
  });
  const res = await q.query(
    `INSERT INTO paper_orders (run_id, seq, ts_intent, ts_fill, base_unit, pool_id, side, unit_in, amount_in, unit_out, amount_out, mid_price, fill_price,
       pool_fee_in, batcher_fee_lovelace, network_fee_lovelace, slippage_bps, price_impact_bps, status, reject_reason, reason) VALUES ${tuples.join(', ')}`,
    values);
  return res.rowCount ?? 0;
}
