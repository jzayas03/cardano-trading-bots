import { describe, expect, it } from 'vitest';
import { migrate } from '@ctb/db';
import { PgSnapshotRepo, type SnapshotRow } from '@ctb/collector';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { buildCandlesForToken, PgCandleRepo } from '../src/index.js';

const snek = { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme',
  unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b' };
const t = (m: number) => new Date(Date.UTC(2026, 8, 6, 12, m, 0));
const row = (tickTs: Date, poolId: string, rb: bigint, rq: bigint, tvl: bigint): SnapshotRow => ({
  tickTs, dex: 'SundaeSwapV3', poolId, poolAddress: 'addr', baseUnit: snek.unit, quoteUnit: 'lovelace', reserveBase: rb, reserveQuote: rq,
  feeBps: 100, poolType: 'cpmm', tvlLovelace: tvl, blockHeight: 1, observedAt: tickTs,
});

describe.skipIf(!PG_ENABLED)('PgCandleRepo + buildCandlesForToken', () => {
  it('builds incrementally and idempotently from pool_snapshots', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const snaps = new PgSnapshotRepo(db);
      await snaps.syncTokens([snek], { seededAt: '2026-09-05', seedSource: 'test' });
      const run = await snaps.startRun(t(0), t(0));
      await snaps.insertSnapshots(run, [
        row(t(0), 'SundaeSwapV3:p', 1_000n, 2_000n, 4_000n),
        row(t(0), 'MinswapV2:q', 10n, 20n, 40n),
        row(t(5), 'SundaeSwapV3:p', 900n, 2_250n, 4_500n),
      ]);
      const repo = new PgCandleRepo(db);
      const first = await buildCandlesForToken(repo, snek);
      expect(first).toEqual({ built: 2, from: t(0), to: t(5) });
      const again = await buildCandlesForToken(repo, snek);
      expect(again.built).toBe(0);
      await snaps.insertSnapshots(run, [row(t(10), 'SundaeSwapV3:p', 950n, 2_150n, 4_300n)]);
      const third = await buildCandlesForToken(repo, snek);
      expect(third).toEqual({ built: 1, from: t(10), to: t(10) });
      const candles = await repo.readCandles(snek.unit, t(0), t(10));
      expect(candles.map((c) => c.poolId)).toEqual(['SundaeSwapV3:p', 'SundaeSwapV3:p', 'SundaeSwapV3:p']);
      expect(candles[2]?.netFlowBase).toBe(50n); // 950 - 900, seeded from the stored previous candle
      expect(candles[1]?.close).toBe('0.000002500000000000'); // 2250 lovelace / 900 SNEK = 0.0000025 ADA
      const stored = await db.query<{ close: string; net_flow_quote: string }>('SELECT close, net_flow_quote FROM candles ORDER BY tick_ts');
      expect(stored.rows[1]?.net_flow_quote).toBe('250');
    });
  });
});

/**
 * Final-review finding C1: a single multi-row INSERT of N candles binds N x 14 parameters, and
 * Postgres's wire protocol caps a Bind message at 65535 parameters — so 4682 candles was the point
 * where `candles` (three months of 5-minute ticks is ~26k rows) started failing with
 * "bind message has NNNNN parameters, but at most 65535". The repo now chunks at 1000 rows inside
 * ONE transaction, so the whole build is still all-or-nothing.
 */
describe.skipIf(!PG_ENABLED)('PgCandleRepo bulk insert (finding C1)', () => {
  it('inserts 5000 candles in one transaction, well past the 65535 bind-parameter limit', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await new PgSnapshotRepo(db).syncTokens([snek], { seededAt: '2026-09-05', seedSource: 'test' });
      const repo = new PgCandleRepo(db);
      const rows = Array.from({ length: 5000 }, (_, i) => ({
        baseUnit: snek.unit, tickTs: new Date(Date.UTC(2026, 0, 1) + i * 300_000), poolId: 'SundaeSwapV3:p',
        open: '0.001000000000000000', high: '0.001000000000000000', low: '0.001000000000000000', close: '0.001000000000000000',
        closeReserveBase: 1_000n, closeReserveQuote: 1_000n, feeBps: 100, poolType: 'cpmm' as const, tvlLovelace: 2_000n,
        netFlowBase: null, netFlowQuote: null,
      }));
      expect(await repo.insertCandles(rows)).toBe(5000);
      const count = await db.query<{ n: string }>('SELECT count(*) AS n FROM candles');
      expect(count.rows[0]?.n).toBe('5000');
    });
  });

  it('rolls the whole chunked insert back when a later chunk fails', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await new PgSnapshotRepo(db).syncTokens([snek], { seededAt: '2026-09-05', seedSource: 'test' });
      const repo = new PgCandleRepo(db);
      const rows = Array.from({ length: 1500 }, (_, i) => ({
        baseUnit: snek.unit, tickTs: new Date(Date.UTC(2026, 0, 1) + i * 300_000), poolId: 'SundaeSwapV3:p',
        open: '0.001000000000000000', high: '0.001000000000000000', low: '0.001000000000000000', close: '0.001000000000000000',
        // the CHECK on close_reserve_base is > 0: row 1200 (in the SECOND chunk) violates it
        closeReserveBase: i === 1200 ? 0n : 1_000n, closeReserveQuote: 1_000n, feeBps: 100, poolType: 'cpmm' as const,
        tvlLovelace: 2_000n, netFlowBase: null, netFlowQuote: null,
      }));
      await expect(repo.insertCandles(rows)).rejects.toThrow();
      const count = await db.query<{ n: string }>('SELECT count(*) AS n FROM candles');
      expect(count.rows[0]?.n, 'the first chunk must not survive a failure in the second').toBe('0');
    });
  });
});

/**
 * Final-review finding M5: `candles` are ADA-quoted by construction. `pool_snapshots.quote_unit`
 * carries a CHECK that pins it to 'lovelace' today, but the candle builder took every snapshot row
 * regardless — so the day that CHECK is widened, a deeper non-ADA pool would silently become the
 * candle. The test drops the CHECK to simulate exactly that future migration.
 */
describe.skipIf(!PG_ENABLED)('readSnapshotsSince only reads ADA-quoted snapshots (finding M5)', () => {
  it('ignores a deeper snapshot whose quote_unit is not lovelace', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const snaps = new PgSnapshotRepo(db);
      await snaps.syncTokens([snek], { seededAt: '2026-09-05', seedSource: 'test' });
      await db.query('ALTER TABLE pool_snapshots DROP CONSTRAINT pool_snapshots_quote_unit_check');
      const run = await snaps.startRun(t(0), t(0));
      await snaps.insertSnapshots(run, [row(t(0), 'SundaeSwapV3:ada', 1_000n, 2_000n, 4_000n)]);
      await db.query(
        `INSERT INTO pool_snapshots (run_id, tick_ts, dex, pool_id, pool_address, base_unit, quote_unit, reserve_base, reserve_quote,
           fee_bps, pool_type, tvl_lovelace, block_height, observed_at)
         VALUES ($1, $2, 'SundaeSwapV3', 'SundaeSwapV3:usdm', 'addr', $3, 'usdm-unit', 5, 9, 100, 'cpmm', 999999, 1, $2)`,
        [run, t(0), snek.unit],
      );
      const repo = new PgCandleRepo(db);
      const read = await repo.readSnapshotsSince(snek.unit, null);
      expect(read.map((s) => s.poolId)).toEqual(['SundaeSwapV3:ada']);
      const built = await buildCandlesForToken(repo, snek);
      expect(built.built).toBe(1);
      const candles = await repo.readCandles(snek.unit, t(0), t(0));
      expect(candles[0]?.poolId, 'the deeper non-ADA pool must not become the candle').toBe('SundaeSwapV3:ada');
    });
  });
});
