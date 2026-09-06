import { describe, expect, it } from 'vitest';
import { migrate } from '@ctb/db';
import { PgSnapshotRepo, type SnapshotRow } from '@ctb/collector';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgExternalRepo } from '../src/index.js';

const snek = { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme',
  unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b' };
const t = (m: number) => new Date(Date.UTC(2026, 8, 6, 12, m, 0));
const candle = (tickTs: Date, close: string) => ({ tickTs, open: close, high: close, low: close, close, volumeQuote: '123.456789' });

describe.skipIf(!PG_ENABLED)('PgExternalRepo', () => {
  it('maps, upserts idempotently, reads ascending, reports coverage, and finds known MinswapV2 identifiers', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const snaps = new PgSnapshotRepo(db);
      await snaps.syncTokens([snek], { seededAt: '2026-09-06', seedSource: 'test' });
      const repo = new PgExternalRepo(db);

      await repo.putMap({ unit: snek.unit, externalPoolId: 'aaa', externalDex: 'saturnswap', matchMethod: 'pair_largest_reserve', reserveUsd: 50 });
      await repo.putMap({ unit: snek.unit, externalPoolId: 'bbb', externalDex: 'minswap-cardano', matchMethod: 'identifier', reserveUsd: 100 });
      const map = await repo.getMap(snek.unit);
      expect(map).toEqual({ externalPoolId: 'bbb', externalDex: 'minswap-cardano', matchMethod: 'identifier' });

      const c1 = candle(t(0), '0.002200000000000000');
      const c2 = candle(t(5), '0.002300000000000000');
      const inserted = await repo.upsertExternal(snek.unit, 'bbb', [c1, c2]);
      expect(inserted).toBe(2);
      const reinserted = await repo.upsertExternal(snek.unit, 'bbb', [c1, c2]);
      expect(reinserted).toBe(0);

      const rows = await repo.readExternal(snek.unit, t(0), t(5));
      expect(rows.map((r) => r.tickTs)).toEqual([t(0), t(5)]);
      expect(rows[0]?.volumeQuote).toBe('123.456789');
      expect(rows[1]?.close).toBe('0.002300000000000000');

      const cov = await repo.coverage(snek.unit);
      expect(cov).toEqual({ first: t(0), last: t(5), rows: 2 });

      const run = await snaps.startRun(t(0), t(0));
      const snapshotRow: SnapshotRow = {
        tickTs: t(0), dex: 'MinswapV2', poolId: 'MinswapV2:abc', poolAddress: 'addr', baseUnit: snek.unit, quoteUnit: 'lovelace',
        reserveBase: 10n, reserveQuote: 20n, feeBps: 30, poolType: 'cpmm', tvlLovelace: 40n, blockHeight: 1, observedAt: t(0),
      };
      await snaps.insertSnapshots(run, [snapshotRow]);
      const identifiers = await repo.knownMinswapV2Identifiers(snek.unit);
      expect(identifiers).toEqual(['abc']);
    });
  });
});
