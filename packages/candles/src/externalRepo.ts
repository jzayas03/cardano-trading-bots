import type { Db } from '@ctb/db';
import type { GeckoCandle } from './geckoTerminal.js';

export interface ExternalPoolMap { externalPoolId: string; externalDex: string; matchMethod: string }

export interface ExternalRepo {
  getMap(unit: string): Promise<ExternalPoolMap | null>;
  putMap(m: { unit: string; externalPoolId: string; externalDex: string; matchMethod: 'identifier' | 'pair_largest_reserve'; reserveUsd: number | null }): Promise<void>;
  /** Hex suffixes of MinswapV2 pool_ids we have snapshotted for this token; empty until the collector has run. */
  knownMinswapV2Identifiers(unit: string): Promise<string[]>;
  upsertExternal(unit: string, poolId: string, candles: GeckoCandle[]): Promise<number>;
  readExternal(unit: string, from: Date, to: Date): Promise<GeckoCandle[]>;
  coverage(unit: string): Promise<{ first: Date | null; last: Date | null; rows: number }>;
}

const SOURCE = 'geckoterminal';
const COLS = 9;

export class PgExternalRepo implements ExternalRepo {
  constructor(private readonly db: Db) {}

  async getMap(unit: string): Promise<ExternalPoolMap | null> {
    const r = await this.db.query<{ external_pool_id: string; external_dex: string; match_method: string }>(
      'SELECT external_pool_id, external_dex, match_method FROM external_pool_map WHERE base_unit = $1 AND source = $2', [unit, SOURCE]);
    const m = r.rows[0];
    return m ? { externalPoolId: m.external_pool_id, externalDex: m.external_dex, matchMethod: m.match_method } : null;
  }

  async putMap(m: { unit: string; externalPoolId: string; externalDex: string; matchMethod: 'identifier' | 'pair_largest_reserve'; reserveUsd: number | null }): Promise<void> {
    await this.db.query(
      `INSERT INTO external_pool_map (base_unit, source, external_pool_id, external_dex, match_method, reserve_usd) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (base_unit, source) DO UPDATE SET external_pool_id = EXCLUDED.external_pool_id, external_dex = EXCLUDED.external_dex,
         match_method = EXCLUDED.match_method, reserve_usd = EXCLUDED.reserve_usd, matched_at = now()`,
      [m.unit, SOURCE, m.externalPoolId, m.externalDex, m.matchMethod, m.reserveUsd],
    );
  }

  async knownMinswapV2Identifiers(unit: string): Promise<string[]> {
    const r = await this.db.query<{ pool_id: string }>(
      `SELECT DISTINCT pool_id FROM pool_snapshots WHERE base_unit = $1 AND dex = 'MinswapV2'`, [unit]);
    return r.rows.map((x) => x.pool_id.slice('MinswapV2:'.length));
  }

  async upsertExternal(unit: string, poolId: string, candles: GeckoCandle[]): Promise<number> {
    if (candles.length === 0) return 0;
    const values: unknown[] = [];
    const tuples = candles.map((c, i) => {
      values.push(unit, c.tickTs, SOURCE, poolId, c.open, c.high, c.low, c.close, c.volumeQuote);
      return `(${Array.from({ length: COLS }, (_, k) => `$${i * COLS + k + 1}`).join(', ')})`;
    });
    const r = await this.db.query(
      `INSERT INTO candles_external (base_unit, tick_ts, source, external_pool_id, open, high, low, close, volume_quote)
       VALUES ${tuples.join(', ')} ON CONFLICT (base_unit, tick_ts, source) DO NOTHING`, values);
    return r.rowCount ?? 0;
  }

  async readExternal(unit: string, from: Date, to: Date): Promise<GeckoCandle[]> {
    const r = await this.db.query<{ tick_ts: Date; open: string; high: string; low: string; close: string; volume_quote: string }>(
      `SELECT tick_ts, open, high, low, close, volume_quote FROM candles_external WHERE base_unit = $1 AND source = $2 AND tick_ts BETWEEN $3 AND $4 ORDER BY tick_ts`,
      [unit, SOURCE, from, to]);
    return r.rows.map((x) => ({ tickTs: x.tick_ts, open: x.open, high: x.high, low: x.low, close: x.close, volumeQuote: x.volume_quote }));
  }

  async coverage(unit: string): Promise<{ first: Date | null; last: Date | null; rows: number }> {
    const r = await this.db.query<{ first: Date | null; last: Date | null; rows: string }>(
      'SELECT min(tick_ts) AS first, max(tick_ts) AS last, count(*) AS rows FROM candles_external WHERE base_unit = $1 AND source = $2', [unit, SOURCE]);
    const x = r.rows[0];
    return { first: x?.first ?? null, last: x?.last ?? null, rows: Number(x?.rows ?? 0) };
  }
}
