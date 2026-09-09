import { migrate } from '@ctb/db';
import { buildCandlesForToken, PgCandleRepo } from '@ctb/candles';
import { describe, expect, it } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgSnapshotRepo, poolToSnapshot } from '../src/pure.js';
import type { PoolLike } from '../src/pure.js';

/**
 * A secondary (multi-venue) snapshot must be stored and must NEVER reach a candle.
 *
 * `buildCandles` re-picks the deepest pool in each bucket and takes every price from it. Multi-venue
 * sampling writes the other venues' pools so cross-DEX spread can be measured — and a secondary pool
 * that was momentarily deeper, or a tick where the primary is missing, would switch the candle's
 * pool mid-series. That is the splice recorded in docs/ops/2026-09-07-first-real-candles.md, and the
 * one thing that must not happen to a running 7-day paper run.
 *
 * The fixture is deliberately adversarial: the SECONDARY pool is the deeper one.
 */
const P = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNIT = `${P}534e454b`;
const t = (m: number) => new Date(Date.UTC(2026, 8, 10, 0, m, 0));

const pool = (dex: string, id: string, quote: bigint): PoolLike => ({
  dex, identifier: id, address: `addr_${id}`, assetA: 'lovelace',
  assetB: { policyId: P, nameHex: '534e454b' },
  reserveA: quote, reserveB: 1_000_000n, poolFeePercent: 0.3,
});

describe.skipIf(!PG_ENABLED)('multi-venue snapshots', () => {
  it('stores the secondary pool but keeps it out of the candle, even when it is DEEPER', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, $2, '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [UNIT, P]);
      const repo = new PgSnapshotRepo(db);
      const runId = await repo.startRun(t(0), t(0));
      const ctx = { tickTs: t(0), blockHeight: 1, observedAt: t(0) };

      // primary is the SHALLOWER pool — so if the filter were missing, the candle would take the
      // secondary's price and this test would read 3.0 instead of 2.0
      await repo.insertSnapshots(runId, [
        poolToSnapshot(pool('MinswapV2', 'primary', 2_000_000n), ctx),
        poolToSnapshot(pool('SundaeSwapV3', 'secondary', 3_000_000n), { ...ctx, isPrimary: false }),
      ]);

      const stored = await db.query<{ pool_id: string; is_primary: boolean }>(
        'SELECT pool_id, is_primary FROM pool_snapshots ORDER BY pool_id');
      expect(stored.rows.map((r) => [r.pool_id, r.is_primary])).toEqual([
        ['MinswapV2:primary', true], ['SundaeSwapV3:secondary', false],
      ]);

      await buildCandlesForToken(new PgCandleRepo(db), { unit: UNIT, decimals: 0, ticker: 'SNEK' }, 900);

      const c = await db.query<{ pool_id: string; close: string }>('SELECT pool_id, close::text FROM candles');
      expect(c.rows).toHaveLength(1);
      expect(c.rows[0]!.pool_id).toBe('MinswapV2:primary');
      // price = (reserveQuote/1e6) / (reserveBase/10^decimals): 2 ADA over 1,000,000 whole tokens.
      // Asserted against BOTH pools' prices, so the test states the claim -- the candle took the
      // primary's price and not the deeper secondary's -- rather than just a number.
      const primaryPrice = 2 / 1_000_000;
      const secondaryPrice = 3 / 1_000_000;
      expect(Number(c.rows[0]!.close)).toBeCloseTo(primaryPrice, 12);
      expect(Number(c.rows[0]!.close)).not.toBeCloseTo(secondaryPrice, 12);
    });
  });

  it('defaults is_primary TRUE, so a row that forgets the flag still prices candles', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, $2, '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [UNIT, P]);
      const repo = new PgSnapshotRepo(db);
      const runId = await repo.startRun(t(0), t(0));
      // poolToSnapshot with no isPrimary — the pre-multi-venue shape
      await repo.insertSnapshots(runId, [poolToSnapshot(pool('MinswapV2', 'p', 2_000_000n), { tickTs: t(0), blockHeight: 1, observedAt: t(0) })]);
      const r = await db.query<{ is_primary: boolean }>('SELECT is_primary FROM pool_snapshots');
      expect(r.rows[0]!.is_primary).toBe(true);
    });
  });

  it('a secondary row does not collide with the primary on the snapshot key', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, $2, '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [UNIT, P]);
      const repo = new PgSnapshotRepo(db);
      const runId = await repo.startRun(t(0), t(0));
      const ctx = { tickTs: t(0), blockHeight: 1, observedAt: t(0) };
      // Same token, same tick, different pools — the whole point of a cross-DEX comparison.
      const written = await repo.insertSnapshots(runId, [
        poolToSnapshot(pool('MinswapV2', 'a', 2_000_000n), ctx),
        poolToSnapshot(pool('WingRidersV2', 'b', 1_000_000n), { ...ctx, isPrimary: false }),
        poolToSnapshot(pool('SundaeSwapV3', 'c', 900_000n), { ...ctx, isPrimary: false }),
      ]);
      expect(written).toBe(3);
    });
  });
});
