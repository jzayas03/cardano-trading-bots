import type { Db } from '@ctb/db';
import type { TokenSpec } from '@ctb/universe';
import type { SnapshotRow } from './types.js';

export interface RunError {
  scope: string;
  message: string;
}

export interface RunSummary {
  poolsAttempted: number;
  poolsFailed: number;
  poolsWritten: number;
  providerCalls: number;
  discovered: boolean;
  errors: RunError[];
}

export interface RunRow extends RunSummary {
  id: number;
  tickTs: Date;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface SnapshotRepo {
  syncTokens(tokens: TokenSpec[], seed: { seededAt: string; seedSource: string }): Promise<void>;
  startRun(tickTs: Date, startedAt: Date): Promise<number>;
  /** Returns rows actually inserted; (pool_id, tick_ts) duplicates are skipped, making a re-run of a tick safe. */
  insertSnapshots(runId: number, rows: SnapshotRow[]): Promise<number>;
  finishRun(runId: number, finishedAt: Date, summary: RunSummary): Promise<void>;
  lastRuns(limit: number): Promise<RunRow[]>;
}

/** Number of placeholders contributed by each snapshot row (run_id + 13 pool_snapshots columns). */
const PARAMS_PER_ROW = 14;

export class PgSnapshotRepo implements SnapshotRepo {
  constructor(private readonly db: Db) {}

  async syncTokens(tokens: TokenSpec[], seed: { seededAt: string; seedSource: string }): Promise<void> {
    for (const t of tokens) {
      await this.db.query(
        `INSERT INTO tokens (unit, policy_id, asset_name_hex, ticker, decimals, category, seeded_at, seed_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (unit) DO UPDATE SET ticker = EXCLUDED.ticker, decimals = EXCLUDED.decimals, category = EXCLUDED.category`,
        [t.unit, t.policyId, t.assetNameHex, t.ticker, t.decimals, t.category, seed.seededAt, seed.seedSource],
      );
    }
  }

  async startRun(tickTs: Date, startedAt: Date): Promise<number> {
    const res = await this.db.query<{ id: string }>(
      'INSERT INTO collector_runs (tick_ts, started_at) VALUES ($1, $2) RETURNING id',
      [tickTs, startedAt],
    );
    const id = res.rows[0]?.id;
    if (id === undefined) throw new Error('startRun returned no id');
    return Number(id);
  }

  async insertSnapshots(runId: number, rows: SnapshotRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(
        runId, r.tickTs, r.dex, r.poolId, r.poolAddress, r.baseUnit, r.quoteUnit,
        r.reserveBase.toString(), r.reserveQuote.toString(), r.feeBps, r.poolType,
        r.tvlLovelace.toString(), r.blockHeight, r.observedAt,
      );
      const p = Array.from({ length: PARAMS_PER_ROW }, (_, k) => `$${i * PARAMS_PER_ROW + k + 1}`);
      return `(${p.join(', ')})`;
    });
    const res = await this.db.query(
      `INSERT INTO pool_snapshots (run_id, tick_ts, dex, pool_id, pool_address, base_unit, quote_unit,
         reserve_base, reserve_quote, fee_bps, pool_type, tvl_lovelace, block_height, observed_at)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (pool_id, tick_ts) DO NOTHING`,
      values,
    );
    return res.rowCount ?? 0;
  }

  async finishRun(runId: number, finishedAt: Date, s: RunSummary): Promise<void> {
    await this.db.query(
      `UPDATE collector_runs SET finished_at = $2, pools_attempted = $3, pools_failed = $4, pools_written = $5,
         provider_calls = $6, discovered = $7, errors = $8::jsonb WHERE id = $1`,
      [runId, finishedAt, s.poolsAttempted, s.poolsFailed, s.poolsWritten, s.providerCalls, s.discovered, JSON.stringify(s.errors)],
    );
  }

  async lastRuns(limit: number): Promise<RunRow[]> {
    const res = await this.db.query<{
      id: string; tick_ts: Date; started_at: Date; finished_at: Date | null; pools_attempted: number; pools_failed: number;
      pools_written: number; provider_calls: number; discovered: boolean; errors: RunError[];
    }>('SELECT * FROM collector_runs ORDER BY id DESC LIMIT $1', [limit]);
    return res.rows.map((r) => ({
      id: Number(r.id), tickTs: r.tick_ts, startedAt: r.started_at, finishedAt: r.finished_at,
      poolsAttempted: r.pools_attempted, poolsFailed: r.pools_failed, poolsWritten: r.pools_written,
      providerCalls: r.provider_calls, discovered: r.discovered, errors: r.errors,
    }));
  }
}
