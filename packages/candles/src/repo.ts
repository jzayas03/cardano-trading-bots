import type { Db } from '@ctb/db';
import type { TokenSpec } from '@ctb/universe';
import { buildCandles } from './build.js';
import type { CandleRow, SnapshotForCandle } from './types.js';

type PreviousCandle = Pick<CandleRow, 'tickTs' | 'poolId' | 'closeReserveBase' | 'closeReserveQuote'>;

export interface CandleRepo {
  readSnapshotsSince(baseUnit: string, afterTick: Date | null): Promise<SnapshotForCandle[]>;
  lastCandle(baseUnit: string): Promise<PreviousCandle | null>;
  insertCandles(rows: CandleRow[]): Promise<number>;
  readCandles(baseUnit: string, from: Date, to: Date): Promise<CandleRow[]>;
}

const CANDLE_COLS = 14;

export class PgCandleRepo implements CandleRepo {
  constructor(private readonly db: Db) {}

  async readSnapshotsSince(baseUnit: string, afterTick: Date | null): Promise<SnapshotForCandle[]> {
    const res = await this.db.query<{
      tick_ts: Date; pool_id: string; reserve_base: string; reserve_quote: string; fee_bps: number; pool_type: 'cpmm'; tvl_lovelace: string;
    }>(
      `SELECT tick_ts, pool_id, reserve_base, reserve_quote, fee_bps, pool_type, tvl_lovelace
         FROM pool_snapshots WHERE base_unit = $1 AND ($2::timestamptz IS NULL OR tick_ts > $2) ORDER BY tick_ts, pool_id`,
      [baseUnit, afterTick],
    );
    return res.rows.map((r) => ({
      tickTs: r.tick_ts, poolId: r.pool_id, reserveBase: BigInt(r.reserve_base), reserveQuote: BigInt(r.reserve_quote),
      feeBps: r.fee_bps, poolType: r.pool_type, tvlLovelace: BigInt(r.tvl_lovelace),
    }));
  }

  async lastCandle(baseUnit: string): Promise<PreviousCandle | null> {
    const res = await this.db.query<{ tick_ts: Date; pool_id: string; close_reserve_base: string; close_reserve_quote: string }>(
      'SELECT tick_ts, pool_id, close_reserve_base, close_reserve_quote FROM candles WHERE base_unit = $1 ORDER BY tick_ts DESC LIMIT 1',
      [baseUnit],
    );
    const r = res.rows[0];
    return r ? { tickTs: r.tick_ts, poolId: r.pool_id, closeReserveBase: BigInt(r.close_reserve_base), closeReserveQuote: BigInt(r.close_reserve_quote) } : null;
  }

  async insertCandles(rows: CandleRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(
        r.baseUnit, r.tickTs, r.poolId, r.open, r.high, r.low, r.close,
        r.closeReserveBase.toString(), r.closeReserveQuote.toString(), r.feeBps, r.poolType, r.tvlLovelace.toString(),
        r.netFlowBase === null ? null : r.netFlowBase.toString(), r.netFlowQuote === null ? null : r.netFlowQuote.toString(),
      );
      return `(${Array.from({ length: CANDLE_COLS }, (_, k) => `$${i * CANDLE_COLS + k + 1}`).join(', ')})`;
    });
    const res = await this.db.query(
      `INSERT INTO candles (base_unit, tick_ts, pool_id, open, high, low, close, close_reserve_base, close_reserve_quote, fee_bps, pool_type,
         tvl_lovelace, net_flow_base, net_flow_quote) VALUES ${tuples.join(', ')} ON CONFLICT (base_unit, tick_ts) DO NOTHING`,
      values,
    );
    return res.rowCount ?? 0;
  }

  async readCandles(baseUnit: string, from: Date, to: Date): Promise<CandleRow[]> {
    const res = await this.db.query<{
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

/** Incremental, idempotent: only snapshots after the last stored candle are read; the last candle seeds the first delta. */
export async function buildCandlesForToken(
  repo: CandleRepo,
  token: Pick<TokenSpec, 'unit' | 'decimals' | 'ticker'>,
): Promise<{ built: number; from: Date | null; to: Date | null }> {
  const previous = await repo.lastCandle(token.unit);
  const snapshots = await repo.readSnapshotsSince(token.unit, previous?.tickTs ?? null);
  const rows = buildCandles(token.unit, token.decimals, snapshots, previous ?? undefined);
  const built = await repo.insertCandles(rows);
  return { built, from: rows[0]?.tickTs ?? null, to: rows.at(-1)?.tickTs ?? null };
}
