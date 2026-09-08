import { withTransaction, type Db, type Queryable } from '@ctb/db';
import type { TokenSpec } from '@ctb/universe';
import { buildCandles } from './build.js';
import type { CandleRow, SnapshotForCandle } from './types.js';

type PreviousCandle = Pick<CandleRow, 'tickTs' | 'poolId' | 'closeReserveBase' | 'closeReserveQuote'>;

export interface CandleRepo {
  readSnapshotsSince(baseUnit: string, afterTick: Date | null): Promise<SnapshotForCandle[]>;
  lastCandle(baseUnit: string): Promise<PreviousCandle | null>;
  insertCandles(rows: CandleRow[]): Promise<number>;
  readCandles(baseUnit: string, from: Date, to: Date): Promise<CandleRow[]>;
  /** Runs `fn` against a repo bound to one transaction, so a read-then-write sequence is atomic. */
  transaction<T>(fn: (repo: CandleRepo) => Promise<T>): Promise<T>;
}

const CANDLE_COLS = 14;

/**
 * Postgres's wire protocol caps one Bind message at 65535 parameters, so a single multi-row INSERT
 * of 14-column candles failed at 4682 rows — reachable by any real build (three months of 5-minute
 * ticks is ~26k rows). 1000 rows is 14 000 parameters, comfortably inside the cap for the widest
 * table here too (paper_orders, 20 columns = 20 000), and every chunk runs inside one transaction so
 * a partial write is impossible (finding C1).
 */
export const INSERT_CHUNK_ROWS = 1000;

async function insertCandleChunk(q: Queryable, rows: CandleRow[]): Promise<number> {
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    values.push(
      r.baseUnit, r.tickTs, r.poolId, r.open, r.high, r.low, r.close,
      r.closeReserveBase.toString(), r.closeReserveQuote.toString(), r.feeBps, r.poolType, r.tvlLovelace.toString(),
      r.netFlowBase === null ? null : r.netFlowBase.toString(), r.netFlowQuote === null ? null : r.netFlowQuote.toString(),
    );
    return `(${Array.from({ length: CANDLE_COLS }, (_, k) => `$${i * CANDLE_COLS + k + 1}`).join(', ')})`;
  });
  const res = await q.query(
    `INSERT INTO candles (base_unit, tick_ts, pool_id, open, high, low, close, close_reserve_base, close_reserve_quote, fee_bps, pool_type,
       tvl_lovelace, net_flow_base, net_flow_quote) VALUES ${tuples.join(', ')} ON CONFLICT (base_unit, tick_ts) DO NOTHING`,
    values,
  );
  return res.rowCount ?? 0;
}

export class PgCandleRepo implements CandleRepo {
  private readonly q: Queryable;

  /** `q` is passed only by `transaction()`, to bind this repo to one checked-out client. */
  constructor(private readonly db: Db, q?: Queryable) {
    this.q = q ?? db;
  }

  private get inTransaction(): boolean {
    return this.q !== this.db;
  }

  async transaction<T>(fn: (repo: CandleRepo) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this); // already inside one: never nest BEGIN
    return withTransaction(this.db, (client) => fn(new PgCandleRepo(this.db, client)));
  }

  async readSnapshotsSince(baseUnit: string, afterTick: Date | null): Promise<SnapshotForCandle[]> {
    const res = await this.q.query<{
      tick_ts: Date; pool_id: string; reserve_base: string; reserve_quote: string; fee_bps: number; pool_type: 'cpmm'; tvl_lovelace: string;
    }>(
      // quote_unit is pinned to 'lovelace' by a CHECK today, but candles are ADA-quoted by
      // construction (price = reserve_quote / reserve_base, in ADA). Filtering here means the day
      // that CHECK is widened, a deeper non-ADA pool cannot silently become the candle (finding M5).
      `SELECT tick_ts, pool_id, reserve_base, reserve_quote, fee_bps, pool_type, tvl_lovelace
         FROM pool_snapshots WHERE base_unit = $1 AND quote_unit = 'lovelace' AND ($2::timestamptz IS NULL OR tick_ts > $2) ORDER BY tick_ts, pool_id`,
      [baseUnit, afterTick],
    );
    return res.rows.map((r) => ({
      tickTs: r.tick_ts, poolId: r.pool_id, reserveBase: BigInt(r.reserve_base), reserveQuote: BigInt(r.reserve_quote),
      feeBps: r.fee_bps, poolType: r.pool_type, tvlLovelace: BigInt(r.tvl_lovelace),
    }));
  }

  async lastCandle(baseUnit: string): Promise<PreviousCandle | null> {
    const res = await this.q.query<{ tick_ts: Date; pool_id: string; close_reserve_base: string; close_reserve_quote: string }>(
      'SELECT tick_ts, pool_id, close_reserve_base, close_reserve_quote FROM candles WHERE base_unit = $1 ORDER BY tick_ts DESC LIMIT 1',
      [baseUnit],
    );
    const r = res.rows[0];
    return r ? { tickTs: r.tick_ts, poolId: r.pool_id, closeReserveBase: BigInt(r.close_reserve_base), closeReserveQuote: BigInt(r.close_reserve_quote) } : null;
  }

  async insertCandles(rows: CandleRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const run = async (q: Queryable): Promise<number> => {
      let inserted = 0;
      for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) {
        inserted += await insertCandleChunk(q, rows.slice(i, i + INSERT_CHUNK_ROWS));
      }
      return inserted;
    };
    return this.inTransaction ? run(this.q) : withTransaction(this.db, run);
  }

  async readCandles(baseUnit: string, from: Date, to: Date): Promise<CandleRow[]> {
    const res = await this.q.query<{
      base_unit: string; tick_ts: Date; pool_id: string; open: string; high: string; low: string; close: string; close_reserve_base: string;
      close_reserve_quote: string; fee_bps: number; pool_type: 'cpmm'; tvl_lovelace: string; net_flow_base: string | null; net_flow_quote: string | null;
    }>('SELECT * FROM candles WHERE base_unit = $1 AND tick_ts BETWEEN $2 AND $3 ORDER BY tick_ts', [baseUnit, from, to]);
    return res.rows.map((r) => ({
      baseUnit: r.base_unit, tickTs: r.tick_ts, poolId: r.pool_id, open: r.open, high: r.high, low: r.low, close: r.close,
      closeReserveBase: BigInt(r.close_reserve_base), closeReserveQuote: BigInt(r.close_reserve_quote), feeBps: r.fee_bps, poolType: r.pool_type,
      tvlLovelace: BigInt(r.tvl_lovelace), netFlowBase: r.net_flow_base === null ? null : BigInt(r.net_flow_base),
      netFlowQuote: r.net_flow_quote === null ? null : BigInt(r.net_flow_quote),
    }));
  }
}

/**
 * Incremental, idempotent: only snapshots after the last stored candle are read; the last candle
 * seeds the first delta. lastCandle -> readSnapshotsSince -> insertCandles all run inside ONE
 * transaction, so the watermark a build reads is the watermark it writes against (finding C1).
 */
export async function buildCandlesForToken(
  repo: CandleRepo,
  token: Pick<TokenSpec, 'unit' | 'decimals' | 'ticker'>,
  /** Bucket several snapshots into one candle. 0 keeps one candle per snapshot, exactly as before. */
  candleIntervalSec = 0,
): Promise<{ built: number; from: Date | null; to: Date | null }> {
  return repo.transaction(async (tx) => {
    const previous = await tx.lastCandle(token.unit);
    const snapshots = await tx.readSnapshotsSince(token.unit, previous?.tickTs ?? null);
    const rows = buildCandles(token.unit, token.decimals, snapshots, previous ?? undefined, candleIntervalSec);
    const built = await tx.insertCandles(rows);
    return { built, from: rows[0]?.tickTs ?? null, to: rows.at(-1)?.tickTs ?? null };
  });
}
