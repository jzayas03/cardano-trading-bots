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
