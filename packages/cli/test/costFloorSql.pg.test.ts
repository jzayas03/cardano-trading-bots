/**
 * Pins the SQL behind `cost-floor`. Everything else in the report is pure and unit-tested in
 * @ctb/reports; this one query is SQL, so it is tested against a real Postgres.
 *
 * The test imports SNAPSHOT_SQL from the command rather than transcribing it: a test that pins its
 * own copy proves the copy, not the code.
 */
import { migrate } from '@ctb/db';
import { describe, expect, it } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { SNAPSHOT_SQL, type SnapshotRow } from '../src/commands/costFloor.js';

describe.skipIf(!PG_ENABLED)('cost-floor snapshot query', () => {
  it('returns only lovelace-quoted cpmm pools, as text, ordered by pool and tick', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      // tokens.unit must equal policy_id || asset_name_hex, and policy_id is exactly 56 chars.
      const policy = 'a'.repeat(56);
      const unit = `${policy}746f6b`;
      await db.query(
        `INSERT INTO tokens (unit, policy_id, asset_name_hex, ticker, decimals, category, seeded_at, seed_source)
         VALUES ($1, $2, '746f6b', 'TOK', 6, 'test', '2026-09-10', 'fixture')`,
        [unit, policy],
      );
      await db.query(
        `INSERT INTO collector_runs (id, tick_ts, started_at) VALUES (1, now(), now())`,
      );
      const base = `INSERT INTO pool_snapshots
        (run_id, tick_ts, dex, pool_id, pool_address, base_unit, quote_unit,
         reserve_base, reserve_quote, fee_bps, pool_type, tvl_lovelace, block_height, observed_at)
        VALUES `;
      await db.query(
        base +
          `(1, '2026-09-10T00:00:00Z', 'MinswapV2', 'MinswapV2:aaa', 'addr1', $1, 'lovelace',
             1000000000, 2000000000, 30, 'cpmm', 3000000000, 1, now()),
           (1, '2026-09-10T00:15:00Z', 'MinswapV2', 'MinswapV2:aaa', 'addr1', $1, 'lovelace',
             1000000001, 2000000001, 30, 'cpmm', 3000000000, 2, now())`,
        [unit],
      );

      const rows = await db.query<SnapshotRow>(SNAPSHOT_SQL, ['2026-09-01T00:00:00Z', null]);
      expect(rows.rows).toHaveLength(2);

      // numeric comes back as TEXT so lovelace survives; Number() here would be the bug.
      expect(typeof rows.rows[0]!.reserve_base).toBe('string');
      expect(BigInt(rows.rows[0]!.reserve_quote)).toBe(2_000_000_000n);
      expect(rows.rows[0]!.tick_ts.getTime()).toBeLessThan(rows.rows[1]!.tick_ts.getTime());

      // The pool filter narrows to one pool, and a miss returns nothing rather than everything.
      const filtered = await db.query<SnapshotRow>(SNAPSHOT_SQL, ['2026-09-01T00:00:00Z', 'MinswapV2:aaa']);
      expect(filtered.rows).toHaveLength(2);
      const missed = await db.query<SnapshotRow>(SNAPSHOT_SQL, ['2026-09-01T00:00:00Z', 'MinswapV2:nope']);
      expect(missed.rows).toEqual([]);

      // `since` excludes earlier ticks.
      const later = await db.query<SnapshotRow>(SNAPSHOT_SQL, ['2026-09-10T00:10:00Z', null]);
      expect(later.rows).toHaveLength(1);
    });
  });
});
