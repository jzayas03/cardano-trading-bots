import { migrate, type Db } from '@ctb/db';
import { PgExternalRepo } from '@ctb/candles';
import { PgSnapshotRepo, type SnapshotRow } from '@ctb/collector/pure';
import { PgRunRepo } from '@ctb/engine';
import { describe, expect, it } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgDashboardReads } from '../src/reads.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const t = (m: number) => new Date(Date.UTC(2026, 8, 6, 12, m));

describe.skipIf(!PG_ENABLED)('PgDashboardReads.listRuns', () => {
  it('filters, paginates and clamps against three real runs', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [SNEK]);
      const runs = new PgRunRepo(db);
      const reads = new PgDashboardReads(db);

      // id 1: a running paper rehearsal.
      const paperRehearsalId = await runs.createRun({
        mode: 'paper', strategyId: 'ma-crossover', params: {}, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10), status: 'running', rehearsal: true,
      });
      // id 2: a finished backtest.
      const backtestId = await runs.createRun({
        mode: 'backtest', strategyId: 'buy-and-hold', params: {}, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10),
      });
      // id 3: a finished (non-rehearsal) paper run.
      const paperFinishedId = await runs.createRun({
        mode: 'paper', strategyId: 'rsi-mean-reversion', params: {}, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10), status: 'finished',
      });

      const all = await reads.listRuns({}, 10, 0);
      expect(all.map((r) => r.id)).toEqual([paperFinishedId, backtestId, paperRehearsalId]);

      const paperOnly = await reads.listRuns({ mode: 'paper' }, 10, 0);
      expect(paperOnly).toHaveLength(2);
      expect(paperOnly.every((r) => r.mode === 'paper')).toBe(true);

      const running = await reads.listRuns({ status: 'running' }, 10, 0);
      expect(running).toHaveLength(1);
      expect(running[0]?.id).toBe(paperRehearsalId);

      const middle = await reads.listRuns({}, 1, 1);
      expect(middle).toHaveLength(1);
      expect(middle[0]?.id).toBe(backtestId);

      // A caller passing an absurd limit gets the clamp (500), not an unbounded scan — with only
      // three rows in the schema this just proves the call does not throw and returns everything.
      const clamped = await reads.listRuns({}, 9999, 0);
      expect(clamped).toHaveLength(3);

      const byStrategy = await reads.listRuns({ strategy: 'buy-and-hold' }, 10, 0);
      expect(byStrategy.map((r) => r.id)).toEqual([backtestId]);

      const byUnit = await reads.listRuns({ unit: SNEK }, 10, 0);
      expect(byUnit).toHaveLength(3);

      const noMatch = await reads.listRuns({ unit: 'nope' }, 10, 0);
      expect(noMatch).toHaveLength(0);
    });
  });
});

/**
 * M4c (`/universe`): a fixture with three tokens.
 *  - DEEP: three pools at the NEWEST tick — a shallow one alphabetically FIRST (`SundaeSwapV3:aaa`,
 *    reserve_quote 1000), and two DEEPER pools tied at reserve_quote 9000 (`SundaeSwapV3:mmm` and
 *    `SundaeSwapV3:zzz`). This one fixture proves both rules at once: the shallow-but-alphabetically-
 *    first pool must NOT win (deepest reserve_quote wins, not pool_id order), and between the two tied
 *    pools the smaller pool_id (`mmm` < `zzz`) must win. DEEP also gets an `external_pool_map` entry
 *    with two imported candles — the "one with external coverage" token.
 *  - STALE: one pool, but only at the OLDER tick (10 minutes before the newest) — absent from
 *    `latestSnapshotsPerToken` entirely, present in `snapshotsAt` only when the window reaches back
 *    that far. No external coverage — the "one without" token.
 *  - THIN: one pool at the NEWEST tick, no external coverage — a plain token with nothing special
 *    about it, so a two-property fixture (DEEP, STALE) can't accidentally pass by only ever seeing one
 *    OTHER token in every query.
 */
describe.skipIf(!PG_ENABLED)('PgDashboardReads.latestSnapshotsPerToken / snapshotsAt / externalCoverageAll', () => {
  const POLICY = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f';
  const deep = { ticker: 'DEEP', policyId: POLICY, assetNameHex: '44454550', decimals: 0, category: 'Meme', unit: `${POLICY}44454550` };
  const stale = { ticker: 'STALE', policyId: POLICY, assetNameHex: '5354414c45', decimals: 0, category: 'Meme', unit: `${POLICY}5354414c45` };
  const thin = { ticker: 'THIN', policyId: POLICY, assetNameHex: '5448494e', decimals: 0, category: 'Meme', unit: `${POLICY}5448494e` };

  const OLDER_TICK = t(0);
  const NEWEST_TICK = t(10);

  const snapshot = (tickTs: Date, baseUnit: string, poolId: string, reserveQuote: bigint): SnapshotRow => ({
    tickTs, dex: 'SundaeSwapV3', poolId, poolAddress: 'addr', baseUnit, quoteUnit: 'lovelace',
    reserveBase: 1_000_000n, reserveQuote, feeBps: 30, poolType: 'cpmm', tvlLovelace: reserveQuote, blockHeight: 1, observedAt: tickTs,
  });

  async function seed(db: Db): Promise<void> {
    const snaps = new PgSnapshotRepo(db);
    await snaps.syncTokens([deep, stale, thin], { seededAt: '2026-09-06', seedSource: 'test' });
    const run = await snaps.startRun(NEWEST_TICK, NEWEST_TICK);
    await snaps.insertSnapshots(run, [
      snapshot(NEWEST_TICK, deep.unit, 'SundaeSwapV3:aaa', 1_000n), // shallow, alphabetically first — must NOT win
      snapshot(NEWEST_TICK, deep.unit, 'SundaeSwapV3:zzz', 9_000n), // tied-deepest, alphabetically LAST — must lose the tie-break
      snapshot(NEWEST_TICK, deep.unit, 'SundaeSwapV3:mmm', 9_000n), // tied-deepest, alphabetically smaller — must win
      snapshot(OLDER_TICK, stale.unit, 'SundaeSwapV3:stale1', 500n),
      snapshot(NEWEST_TICK, thin.unit, 'SundaeSwapV3:thin1', 2_000n),
    ]);

    const external = new PgExternalRepo(db);
    await external.putMap({ unit: deep.unit, externalPoolId: 'ext-deep', externalDex: 'saturnswap', matchMethod: 'pair_largest_reserve', reserveUsd: 10 });
    await external.upsertExternal(deep.unit, 'ext-deep', [
      { tickTs: t(0), open: '0.001', high: '0.001', low: '0.001', close: '0.001', volumeQuote: '1' },
      { tickTs: t(5), open: '0.001', high: '0.001', low: '0.001', close: '0.001', volumeQuote: '1' },
    ], 'ada');
  }

  it('latestSnapshotsPerToken: deepest pool wins over alphabetical order, ties break on smallest pool_id, and a token whose only snapshot is older than the newest tick is absent', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seed(db);
      const reads = new PgDashboardReads(db);

      const latest = await reads.latestSnapshotsPerToken();
      const byUnit = new Map(latest.map((s) => [s.unit, s]));

      expect(byUnit.has(stale.unit), 'STALE has no snapshot on the newest tick and must be absent, not padded in with its older row').toBe(false);
      expect(latest).toHaveLength(2); // DEEP, THIN — STALE excluded

      const deepRow = byUnit.get(deep.unit);
      expect(deepRow?.poolId).toBe('SundaeSwapV3:mmm');
      expect(deepRow?.reserveQuote).toBe(9_000n);
      expect(deepRow?.tickTs).toEqual(NEWEST_TICK);

      const thinRow = byUnit.get(thin.unit);
      expect(thinRow?.poolId).toBe('SundaeSwapV3:thin1');
      expect(thinRow?.reserveQuote).toBe(2_000n);
    });
  });

  /**
   * MINOR finding 6 (fix round): `latestSnapshotsPerToken`/`snapshotsAt` tie-break on `tvl_lovelace`,
   * the same column `packages/candles/src/build.ts`'s `buildCandles` sorts by — not `reserve_quote`,
   * which is only DISPLAYED as "depth ADA". Every other fixture in this file sets
   * `tvl_lovelace = reserve_quote` (via `snapshot()`'s default), so neither ordering can be told apart
   * there. This fixture deliberately makes the two columns DISAGREE — a pool with the higher
   * `reserve_quote` but the lower `tvl_lovelace` — so a pass here proves the query reads the column it
   * claims to, not the one it happens to equal today.
   */
  it('latestSnapshotsPerToken: orders by tvl_lovelace, not reserve_quote, when the two disagree', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const snaps = new PgSnapshotRepo(db);
      await snaps.syncTokens([thin], { seededAt: '2026-09-06', seedSource: 'test' });
      const run = await snaps.startRun(NEWEST_TICK, NEWEST_TICK);
      await snaps.insertSnapshots(run, [
        // Higher reserve_quote (9_000), but LOWER tvl_lovelace (1_000) — must LOSE.
        { ...snapshot(NEWEST_TICK, thin.unit, 'SundaeSwapV3:high-reserve', 9_000n), tvlLovelace: 1_000n },
        // Lower reserve_quote (1_000), but HIGHER tvl_lovelace (20_000) — must WIN.
        { ...snapshot(NEWEST_TICK, thin.unit, 'SundaeSwapV3:high-tvl', 1_000n), tvlLovelace: 20_000n },
      ]);

      const reads = new PgDashboardReads(db);
      const latest = await reads.latestSnapshotsPerToken();
      expect(latest).toHaveLength(1);
      expect(latest[0]?.poolId).toBe('SundaeSwapV3:high-tvl');
      expect(latest[0]?.tvlLovelace).toBe(20_000n);
      expect(latest[0]?.reserveQuote).toBe(1_000n); // the lower-reserve pool still wins — tvl_lovelace decides
    });
  });

  it('snapshotsAt: returns the row at or before the target and nothing older than the window; a target before any snapshot returns []', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seed(db);
      const reads = new PgDashboardReads(db);

      // A wide window (20 minutes) reaches back to STALE's older tick (10 minutes before NEWEST_TICK).
      const wide = await reads.snapshotsAt(NEWEST_TICK, 20 * 60_000);
      const wideByUnit = new Map(wide.map((s) => [s.unit, s]));
      expect(wide).toHaveLength(3);
      expect(wideByUnit.get(stale.unit)?.tickTs).toEqual(OLDER_TICK);
      expect(wideByUnit.get(stale.unit)?.reserveQuote).toBe(500n);
      expect(wideByUnit.get(deep.unit)?.poolId).toBe('SundaeSwapV3:mmm'); // same tie-break rule applies here

      // A narrow window (5 minutes) does not reach STALE's older tick — it must be absent, not padded
      // in with a stale value.
      const narrow = await reads.snapshotsAt(NEWEST_TICK, 5 * 60_000);
      const narrowByUnit = new Map(narrow.map((s) => [s.unit, s]));
      expect(narrowByUnit.has(stale.unit), 'STALE\'s only snapshot is 10 minutes before the target, outside a 5-minute window').toBe(false);
      expect(narrow).toHaveLength(2);

      // A target before any snapshot exists at all returns an empty array, never an error.
      const nothing = await reads.snapshotsAt(new Date(Date.UTC(2020, 0, 1)), 20 * 60_000);
      expect(nothing).toEqual([]);
    });
  });

  /**
   * Fix round, IMPORTANT 1: nothing above proves per-token "newest tick wins" as distinct from
   * "deepest pool wins" — every token in `seed()`'s fixture that has more than one candidate row has
   * them all on the SAME tick (DEEP's three pools), so `ORDER BY base_unit, tick_ts DESC, reserve_quote
   * DESC, pool_id` and a hypothetical `ORDER BY base_unit, tick_ts ASC, reserve_quote DESC, pool_id`
   * would return the identical row for every existing assertion — the entire Postgres suite stayed
   * green under that flip (reviewer finding). This test gives ONE token two snapshots at two DIFFERENT
   * ticks, both inside the query window, with the OLDER tick holding the DEEPER pool — the two rules
   * pull in opposite directions, so only the correct (`tick_ts DESC`) ordering picks the newer,
   * shallower row; the wrong (`tick_ts ASC`) ordering would pick the older, deeper one instead.
   */
  it('snapshotsAt: a token\'s NEWEST qualifying tick wins even when an OLDER tick in the window has a deeper pool', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const snaps = new PgSnapshotRepo(db);
      await snaps.syncTokens([thin], { seededAt: '2026-09-06', seedSource: 'test' });
      const olderDeeper = t(0);
      const newerShallower = t(8);
      const run = await snaps.startRun(newerShallower, newerShallower);
      await snaps.insertSnapshots(run, [
        // Deeper pool (9_000), but on the OLDER tick — must lose to the newer tick below.
        snapshot(olderDeeper, thin.unit, 'SundaeSwapV3:old-deep', 9_000n),
        // Shallower pool (1_000), but on the NEWER tick — must win: per-token "newest qualifying tick"
        // outranks "deepest pool" (the deepest-pool tie-break only applies AMONG rows sharing the
        // winning tick_ts, not across different ticks).
        snapshot(newerShallower, thin.unit, 'SundaeSwapV3:new-shallow', 1_000n),
      ]);

      const reads = new PgDashboardReads(db);
      const result = await reads.snapshotsAt(newerShallower, 20 * 60_000);
      expect(result).toHaveLength(1);
      expect(result[0]?.tickTs).toEqual(newerShallower);
      expect(result[0]?.poolId).toBe('SundaeSwapV3:new-shallow');
      expect(result[0]?.reserveQuote).toBe(1_000n);
    });
  });

  it('externalCoverageAll: one row per mapped unit; a token with no external_pool_map entry has no row at all', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seed(db);
      const reads = new PgDashboardReads(db);

      const coverage = await reads.externalCoverageAll();
      expect(coverage).toHaveLength(1); // only DEEP is mapped
      expect(coverage[0]).toEqual({ unit: deep.unit, rows: 2, first: t(0), last: t(5) });

      const byUnit = new Map(coverage.map((c) => [c.unit, c]));
      expect(byUnit.has(stale.unit)).toBe(false);
      expect(byUnit.has(thin.unit)).toBe(false);
    });
  });
});
