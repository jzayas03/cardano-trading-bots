import { withTransaction, type Db, type Queryable } from '@ctb/db';
import type { GeckoCandle } from './geckoTerminal.js';
import { INSERT_CHUNK_ROWS } from './repo.js';

export interface ExternalPoolMap { externalPoolId: string; externalDex: string; matchMethod: string }

export interface ExternalRepo {
  getMap(unit: string): Promise<ExternalPoolMap | null>;
  putMap(m: { unit: string; externalPoolId: string; externalDex: string; matchMethod: 'identifier' | 'pair_largest_reserve'; reserveUsd: number | null }): Promise<void>;
  /** Hex suffixes of MinswapV2 pool_ids we have snapshotted for this token; empty until the collector has run. */
  knownMinswapV2Identifiers(unit: string): Promise<string[]>;
  upsertExternal(unit: string, poolId: string, candles: GeckoCandle[]): Promise<number>;
  /** Only rows of the pool `external_pool_map` currently points at — never a mix of pools. */
  readExternal(unit: string, from: Date, to: Date): Promise<GeckoCandle[]>;
  coverage(unit: string): Promise<{ first: Date | null; last: Date | null; rows: number }>;
}

const SOURCE = 'geckoterminal';
const COLS = 9;

/**
 * Finding I3: `candles_external` can now hold more than one pool per token (migration 0003 widened
 * the primary key). Every read therefore has to say WHICH pool it means, and the answer is the one
 * `external_pool_map` currently points at — joining is what keeps a re-pin from stitching two pools'
 * prices into one series. A token with no map row reads as no history, which is correct: nothing has
 * decided which pool stands for it.
 */
const MAPPED_POOL_JOIN = `
  JOIN external_pool_map m ON m.base_unit = ce.base_unit AND m.source = ce.source AND m.external_pool_id = ce.external_pool_id`;

export class PgExternalRepo implements ExternalRepo {
  private readonly q: Queryable;

  constructor(private readonly db: Db, q?: Queryable) {
    this.q = q ?? db;
  }

  async getMap(unit: string): Promise<ExternalPoolMap | null> {
    const r = await this.q.query<{ external_pool_id: string; external_dex: string; match_method: string }>(
      'SELECT external_pool_id, external_dex, match_method FROM external_pool_map WHERE base_unit = $1 AND source = $2', [unit, SOURCE]);
    const m = r.rows[0];
    return m ? { externalPoolId: m.external_pool_id, externalDex: m.external_dex, matchMethod: m.match_method } : null;
  }

  async putMap(m: { unit: string; externalPoolId: string; externalDex: string; matchMethod: 'identifier' | 'pair_largest_reserve'; reserveUsd: number | null }): Promise<void> {
    await this.q.query(
      `INSERT INTO external_pool_map (base_unit, source, external_pool_id, external_dex, match_method, reserve_usd) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (base_unit, source) DO UPDATE SET external_pool_id = EXCLUDED.external_pool_id, external_dex = EXCLUDED.external_dex,
         match_method = EXCLUDED.match_method, reserve_usd = EXCLUDED.reserve_usd, matched_at = now()`,
      [m.unit, SOURCE, m.externalPoolId, m.externalDex, m.matchMethod, m.reserveUsd],
    );
  }

  async knownMinswapV2Identifiers(unit: string): Promise<string[]> {
    const r = await this.q.query<{ pool_id: string }>(
      `SELECT DISTINCT pool_id FROM pool_snapshots WHERE base_unit = $1 AND dex = 'MinswapV2'`, [unit]);
    return r.rows.map((x) => x.pool_id.slice('MinswapV2:'.length));
  }

  /** Chunked at INSERT_CHUNK_ROWS inside one transaction: 9 columns x N rows hits the 65535-parameter Bind cap at 7282 rows (finding C1). */
  async upsertExternal(unit: string, poolId: string, candles: GeckoCandle[]): Promise<number> {
    if (candles.length === 0) return 0;
    const run = async (q: Queryable): Promise<number> => {
      let inserted = 0;
      for (let i = 0; i < candles.length; i += INSERT_CHUNK_ROWS) {
        inserted += await upsertExternalChunk(q, unit, poolId, candles.slice(i, i + INSERT_CHUNK_ROWS));
      }
      return inserted;
    };
    return this.q === this.db ? withTransaction(this.db, run) : run(this.q);
  }

  async readExternal(unit: string, from: Date, to: Date): Promise<GeckoCandle[]> {
    const r = await this.q.query<{ tick_ts: Date; open: string; high: string; low: string; close: string; volume_quote: string }>(
      `SELECT ce.tick_ts, ce.open, ce.high, ce.low, ce.close, ce.volume_quote FROM candles_external ce${MAPPED_POOL_JOIN}
        WHERE ce.base_unit = $1 AND ce.source = $2 AND ce.tick_ts BETWEEN $3 AND $4 ORDER BY ce.tick_ts`,
      [unit, SOURCE, from, to]);
    return r.rows.map((x) => ({ tickTs: x.tick_ts, open: x.open, high: x.high, low: x.low, close: x.close, volumeQuote: x.volume_quote }));
  }

  async coverage(unit: string): Promise<{ first: Date | null; last: Date | null; rows: number }> {
    const r = await this.q.query<{ first: Date | null; last: Date | null; rows: string }>(
      `SELECT min(ce.tick_ts) AS first, max(ce.tick_ts) AS last, count(*) AS rows FROM candles_external ce${MAPPED_POOL_JOIN}
        WHERE ce.base_unit = $1 AND ce.source = $2`, [unit, SOURCE]);
    const x = r.rows[0];
    return { first: x?.first ?? null, last: x?.last ?? null, rows: Number(x?.rows ?? 0) };
  }
}

async function upsertExternalChunk(q: Queryable, unit: string, poolId: string, candles: GeckoCandle[]): Promise<number> {
  const values: unknown[] = [];
  const tuples = candles.map((c, i) => {
    values.push(unit, c.tickTs, SOURCE, poolId, c.open, c.high, c.low, c.close, c.volumeQuote);
    return `(${Array.from({ length: COLS }, (_, k) => `$${i * COLS + k + 1}`).join(', ')})`;
  });
  const r = await q.query(
    `INSERT INTO candles_external (base_unit, tick_ts, source, external_pool_id, open, high, low, close, volume_quote)
     VALUES ${tuples.join(', ')} ON CONFLICT (base_unit, tick_ts, source, external_pool_id) DO NOTHING`, values);
  return r.rowCount ?? 0;
}
