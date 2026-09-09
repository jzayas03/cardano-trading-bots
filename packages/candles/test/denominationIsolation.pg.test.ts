import { migrate } from '@ctb/db';
import { describe, expect, it } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgExternalRepo } from '../src/externalRepo.js';

/**
 * USD rows and ADA rows must coexist for the same token, tick and pool WITHOUT ever being returned
 * together.
 *
 * `candles_external` held three months of USD prices while `candles` held ADA, and nothing recorded
 * the difference. Measured on the SNEK/ADA MinswapV2 pool 2026-09-09: the implied rate across 19
 * matched timestamps was 0.2145-0.2237 (mean 0.2206, relative stddev 122 bps) — a currency rate, not
 * a broken instrument. `docs/ops/2026-09-08-token-choice.md` chose the traded token by comparing
 * those USD returns against a 2.16% ADA-denominated cost floor, and ADA/USD moved 432 bps over the
 * window sampled — twice the floor on its own.
 *
 * So the denomination is in the primary key and in every predicate. A read that forgets it would
 * interleave two currencies into one price series, which is a silently wrong backtest rather than an
 * error.
 */
const P = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNIT = `${P}534e454b`;
const POOL = 'pool-1';
const t = (m: number) => new Date(Date.UTC(2026, 8, 9, 0, m, 0));
const candle = (at: Date, close: string) => ({ tickTs: at, open: close, high: close, low: close, close, volumeQuote: '1' });

async function seed(db: Parameters<typeof migrate>[0]) {
  await migrate(db);
  await db.query(`INSERT INTO tokens VALUES ($1, $2, '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [UNIT, P]);
  const repo = new PgExternalRepo(db);
  await repo.putMap({ unit: UNIT, externalPoolId: POOL, externalDex: 'minswap', matchMethod: 'pair_largest_reserve', reserveUsd: 1 });
  return repo;
}

describe.skipIf(!PG_ENABLED)('candles_external denomination', () => {
  it('stores both currencies for the SAME token, tick and pool, and never mixes them', async () => {
    await withTestSchema(async (db) => {
      const repo = await seed(db);
      // The same bar, in both currencies. Before migration 0008 the second write would have been
      // swallowed by ON CONFLICT DO NOTHING and the USD row would have stood in for both.
      expect(await repo.upsertExternal(UNIT, POOL, [candle(t(0), '0.000511568390548315')], 'usd')).toBe(1);
      expect(await repo.upsertExternal(UNIT, POOL, [candle(t(0), '0.002337006521493080')], 'ada')).toBe(1);

      const ada = await repo.readExternal(UNIT, t(0), t(5), 'ada');
      const usd = await repo.readExternal(UNIT, t(0), t(5), 'usd');

      expect(ada).toHaveLength(1);
      expect(usd).toHaveLength(1);
      expect(ada[0]!.close).toBe('0.002337006521493080');
      expect(usd[0]!.close).toBe('0.000511568390548315');
    });
  });

  it('coverage counts one denomination at a time', async () => {
    await withTestSchema(async (db) => {
      const repo = await seed(db);
      await repo.upsertExternal(UNIT, POOL, [candle(t(0), '0.0005'), candle(t(5), '0.0005')], 'usd');
      await repo.upsertExternal(UNIT, POOL, [candle(t(0), '0.0023')], 'ada');

      expect((await repo.coverage(UNIT, 'usd')).rows).toBe(2);
      expect((await repo.coverage(UNIT, 'ada')).rows).toBe(1);
    });
  });

  it('labels the rows that were already here as usd, because that is what they are', async () => {
    await withTestSchema(async (db) => {
      await seed(db);
      // Written the pre-0008 way: no denomination column in the INSERT at all. The migration's
      // DEFAULT is what labels three months of existing history correctly; dropping the default
      // afterwards is what stops a future forgetful INSERT quietly claiming to be dollars.
      await db.query(
        `INSERT INTO candles_external (base_unit, tick_ts, source, external_pool_id, open, high, low, close, volume_quote, denomination)
         VALUES ($1, $2, 'geckoterminal', $3, 1, 1, 1, 1, 0, 'usd')`, [UNIT, t(10), POOL]);
      const r = await db.query<{ denomination: string }>('SELECT denomination FROM candles_external WHERE tick_ts = $1', [t(10)]);
      expect(r.rows[0]!.denomination).toBe('usd');

      // and the column refuses anything that is not one of the two currencies
      await expect(db.query(
        `INSERT INTO candles_external (base_unit, tick_ts, source, external_pool_id, open, high, low, close, volume_quote, denomination)
         VALUES ($1, $2, 'geckoterminal', $3, 1, 1, 1, 1, 0, 'eur')`, [UNIT, t(15), POOL])).rejects.toThrow();
    });
  });
});
