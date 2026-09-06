# Paper-Trading Foundation, Plan 2 of 3 (M2: candles, backfill, engine, simulated executor, backtest)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the collector's 5-minute pool snapshots (and GeckoTerminal history for the past), build candles, run a strategy through one event loop, fill its intents against real pool reserves one candle later with every Cardano cost applied, and print a backtest report that cites its run id, git sha, data source, and fill model.

**Architecture:** Three new packages beside the M0 ones. `@ctb/candles` turns snapshots into dense point-sample candles and imports sparse GeckoTerminal candles into a separate table. `@ctb/engine` owns the `Strategy` interface, indicators, the portfolio, run/order provenance, and the single event loop (a candle feed in, fills and an equity curve out). `@ctb/sim-executor` is the only place fill math lives: constant-product on observed reserves at `t+1`, or on a synthetic depth the operator declares when only external candles exist. The CLI gains `candles`, `backfill`, `backtest`, `report`. Plan 1's missing retry lands in the collector as its own task.

**Tech Stack:** unchanged from Plan 1 (Node 24, TypeScript strict, tsx, Vitest, pg, zod, pino). No new runtime dependencies except none: GeckoTerminal is called with the global `fetch`.

**Spec:** `docs/specs/2026-09-05-paper-trading-foundation.md` (§4.3 candles, §4.4 engine, §4.5 sim-executor, §4.6 cli, §5 data model, §6 error handling, §7 testing, §8 M2)

**Plan 1:** `docs/plans/2026-09-05-m0-m1-collector.md` (merged; its exports are listed under Facts)

## Facts verified on 2026-09-06 (do not re-derive)

- `main` exports, used verbatim here: `@ctb/db` → `createPool(url, onError)`, `migrate(db)`, `type Db`; `@ctb/universe` → `loadUniverse()`, `TokenSpec {ticker, policyId, assetNameHex, decimals, category, unit}`, `Pair`; `@ctb/collector` → `SnapshotRow`, `Logger`, `bucketTick`, `PgSnapshotRepo`, `DexterPoolSource`, `PoolFetcher`, `LiquidityPoolShape`, `isPoolFailure`, `runTick`, `TickDeps`. Test helper `packages/db/test/helpers.ts` → `PG_ENABLED`, `withTestSchema(fn)`.
- `pool_snapshots` columns: `run_id, tick_ts, dex, pool_id, pool_address, base_unit, quote_unit, reserve_base, reserve_quote, fee_bps, pool_type, tvl_lovelace, block_height, observed_at`; PK `(pool_id, tick_ts)`. `tokens` has `unit, decimals, ticker`.
- GeckoTerminal (`https://api.geckoterminal.com/api/v2`, header `Accept: application/json;version=20230302`, no key): network id `cardano`; `GET /networks/cardano/tokens/{unit}/pools?page=1` lists pools with `id` (`cardano_<hex>`), `attributes.name` (e.g. `SNEK / ADA`), `attributes.address`, `attributes.reserve_in_usd`, `relationships.dex.data.id` (`minswap-cardano`, also `saturnswap`). `GET /networks/cardano/pools/{poolHex}/ohlcv/minute?aggregate=5&limit=1000[&before_timestamp=<unix>]` returns `data.attributes.ohlcv_list` as `[unixSeconds, open, high, low, close, volume]` newest first, prices in quote (ADA) per base token, volume in quote; **rows are sparse** (a bucket with no trade has no row); history ≥ 180 days; pagination backwards with `before_timestamp`. **Five rapid calls returned 429**: space calls ≥ 3 s and back off on 429.
- Every universe token probed (SNEK, USDM, HOSKY, STUFF, COPI) has a Minswap v2 `… / ADA` pool on GeckoTerminal whose hex id starts with the Minswap v2 policy `f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c`; the `e4214b7c…` ids are Minswap v1. For Minswap v2 that hex is the LP-token unit, which is what Dexter reports as `identifier` (our `pool_id` = `MinswapV2:<hex>`). **ASSUMPTION to confirm on first live discovery (Task 4 records the match method either way).**
- Hand-computed constants from the live SundaeSwapV3 SNEK/ADA fixture (`reserve_quote` 52 331 970 594 lovelace, `reserve_base` 23 779 491 SNEK with 0 decimals, fee 100 bps), constant-product `out = in·(10000−fee)·rOut / (rIn·10000 + in·(10000−fee))` in bigint: buying with 1 000 000 000 lovelace yields **441 500** SNEK, pool fee **10 000 000** lovelace, slippage vs mid **292 bps**; selling 1 000 000 SNEK yields **2 091 631 632** lovelace, slippage **496 bps**; a 1-lovelace buy at zero fee yields 0. Price of that pool in ADA per SNEK: `0.002200718703104284…`.
- Indicator constants: RSI(3) on closes `[10, 11, 10.5, 11.5]` = **80** (gains 1,0,1 avg ⅔; losses 0,0.5,0 avg ⅙; RS 4). EMA(3) seeded with SMA of `[1,2,3]` = 2, next value 4 → **3**.

## Global Constraints

- Everything in Plan 1's Global Constraints still binds: Node ≥24, ESM, strict TS with `noUncheckedIndexedAccess`, no `any`, no empty catch, `console.*` only in `packages/cli`, parameterized SQL, amounts as `bigint` in code and `numeric(38,0)` in Postgres, prices as `numeric(38,18)` in Postgres and as **decimal strings** across package boundaries (never `number`), pg tests behind `RUN_PG_TESTS=1`, live tests behind `RUN_LIVE_TESTS=1`, every new guard proven red once by reinjection.
- `candles` has **no column named `volume`**. Its flow columns are `net_flow_base` and `net_flow_quote`. Gross volume exists only in `candles_external.volume_quote`. A guard test pins this.
- `pool_type` stays `CHECK (pool_type IN ('cpmm'))`; the executor rejects any other value and any missing `t+1` candle. It never fills at `t`.
- Strategies are pure with respect to time and randomness: no `Date.now()`, no `Math.random()`, no I/O. Determinism is a test.
- Every number printed by `backtest`/`report` traces to a `runs` row that stores strategy id, params, git sha, data source, fill model, and data range.
- One PR per task group as the plan says; every PR branches off `main`; CI (`lint, unit, postgres`) must be green.
- Deprecation of nothing: Plan 1 code is extended, not restructured.

---

### Task 1: Migration 0002 — candles, external candles, pool map, runs, paper orders

**Files:**
- Create: `packages/db/migrations/0002_candles_engine.sql`, `packages/db/test/candlesSchema.pg.test.ts`, `packages/db/test/noVolumeColumn.guard.test.ts`

**Interfaces:**
- Consumes: `migrate`, `withTestSchema`, `PG_ENABLED` from Plan 1.
- Produces tables (exact columns below): `candles`, `candles_external`, `external_pool_map`, `runs`, `paper_orders`.

- [ ] **Step 1: Branch**

```bash
cd ~/code/cardano-trading-bots && git fetch origin && git checkout -b feat/m2-schema origin/main
```

- [ ] **Step 2: Write the failing guard test (static, no database)**

`packages/db/test/noVolumeColumn.guard.test.ts`:
```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/migrate.js';

/**
 * Spec §4.3: locally built candles measure NET reserve flow, not gross volume. A column named
 * `volume` on `candles` would be read as exchange volume by every downstream tool. This guard
 * fails if any migration creates or adds such a column to `candles`.
 */
describe('candles has no volume column (spec §4.3)', () => {
  it('no migration defines a volume column on the candles table', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0002_candles_engine.sql'), 'utf8');
    const candlesDdl = /CREATE TABLE IF NOT EXISTS candles\s*\(([\s\S]*?)\);/m.exec(sql)?.[1];
    expect(candlesDdl, 'candles DDL must exist in 0002').toBeTruthy();
    expect(candlesDdl).toMatch(/net_flow_base\s+numeric\(38,0\)/);
    expect(candlesDdl).toMatch(/net_flow_quote\s+numeric\(38,0\)/);
    expect(candlesDdl).not.toMatch(/^\s*volume\b/m);
    expect(sql).not.toMatch(/ALTER TABLE\s+candles\s+ADD\s+COLUMN\s+volume\b/i);
  });

  it('external candles do carry gross volume, in quote units', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0002_candles_engine.sql'), 'utf8');
    const ext = /CREATE TABLE IF NOT EXISTS candles_external\s*\(([\s\S]*?)\);/m.exec(sql)?.[1];
    expect(ext).toMatch(/volume_quote\s+numeric\(38,6\)/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/db/test/noVolumeColumn.guard.test.ts`
Expected: FAIL (ENOENT, the migration file does not exist).

- [ ] **Step 4: Write the migration**

`packages/db/migrations/0002_candles_engine.sql`:
```sql
-- Locally built candles: one row per (token, 5-minute tick) from pool_snapshots, using the deepest
-- ADA pool at that tick. With one observation per tick, open=high=low=close; the four columns exist
-- so strategies see the same shape as candles_external. Flow is NET reserve change vs the previous
-- tick of the SAME pool (null when the deepest pool changed). There is deliberately no `volume`.
CREATE TABLE IF NOT EXISTS candles (
  base_unit           text NOT NULL REFERENCES tokens(unit),
  tick_ts             timestamptz NOT NULL,
  pool_id             text NOT NULL,
  open                numeric(38,18) NOT NULL CHECK (open > 0),
  high                numeric(38,18) NOT NULL CHECK (high > 0),
  low                 numeric(38,18) NOT NULL CHECK (low > 0),
  close               numeric(38,18) NOT NULL CHECK (close > 0),
  close_reserve_base  numeric(38,0) NOT NULL CHECK (close_reserve_base > 0),
  close_reserve_quote numeric(38,0) NOT NULL CHECK (close_reserve_quote > 0),
  fee_bps             int NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  pool_type           text NOT NULL CHECK (pool_type IN ('cpmm')),
  tvl_lovelace        numeric(38,0) NOT NULL,
  net_flow_base       numeric(38,0),
  net_flow_quote      numeric(38,0),
  PRIMARY KEY (base_unit, tick_ts)
);

-- Imported history. Never merged into candles. Sparse: a bucket with no trade has no row.
CREATE TABLE IF NOT EXISTS candles_external (
  base_unit         text NOT NULL REFERENCES tokens(unit),
  tick_ts           timestamptz NOT NULL,
  source            text NOT NULL CHECK (source IN ('geckoterminal')),
  external_pool_id  text NOT NULL,
  open              numeric(38,18) NOT NULL CHECK (open > 0),
  high              numeric(38,18) NOT NULL CHECK (high > 0),
  low               numeric(38,18) NOT NULL CHECK (low > 0),
  close             numeric(38,18) NOT NULL CHECK (close > 0),
  volume_quote      numeric(38,6) NOT NULL CHECK (volume_quote >= 0),
  imported_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base_unit, tick_ts, source)
);

-- Which external pool stands for which token, and how we decided.
CREATE TABLE IF NOT EXISTS external_pool_map (
  base_unit         text NOT NULL REFERENCES tokens(unit),
  source            text NOT NULL CHECK (source IN ('geckoterminal')),
  external_pool_id  text NOT NULL,
  external_dex      text NOT NULL,
  match_method      text NOT NULL CHECK (match_method IN ('identifier', 'pair_largest_reserve')),
  reserve_usd       numeric(38,2),
  matched_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base_unit, source)
);

-- Provenance for every number a backtest or paper run prints.
CREATE TABLE IF NOT EXISTS runs (
  id                bigserial PRIMARY KEY,
  mode              text NOT NULL CHECK (mode IN ('backtest', 'paper')),
  strategy_id       text NOT NULL,
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  git_sha           text NOT NULL,
  base_unit         text NOT NULL REFERENCES tokens(unit),
  data_source       text NOT NULL CHECK (data_source IN ('candles', 'candles_external')),
  fill_model        text NOT NULL CHECK (fill_model IN ('cpmm_observed', 'cpmm_synthetic_depth')),
  data_from         timestamptz NOT NULL,
  data_to           timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  summary           jsonb
);

-- One row per intent, filled or rejected. Amounts in smallest units of unit_in / unit_out.
CREATE TABLE IF NOT EXISTS paper_orders (
  run_id              bigint NOT NULL REFERENCES runs(id),
  seq                 int NOT NULL,
  ts_intent           timestamptz NOT NULL,
  ts_fill             timestamptz,
  base_unit           text NOT NULL REFERENCES tokens(unit),
  pool_id             text,
  side                text NOT NULL CHECK (side IN ('buy', 'sell')),
  unit_in             text NOT NULL,
  amount_in           numeric(38,0) NOT NULL CHECK (amount_in > 0),
  unit_out            text,
  amount_out          numeric(38,0) CHECK (amount_out >= 0),
  mid_price           numeric(38,18),
  fill_price          numeric(38,18),
  pool_fee_in         numeric(38,0),
  batcher_fee_lovelace numeric(38,0),
  network_fee_lovelace numeric(38,0),
  slippage_bps        int,
  status              text NOT NULL CHECK (status IN ('filled', 'rejected')),
  reject_reason       text,
  reason              text NOT NULL,
  PRIMARY KEY (run_id, seq),
  CHECK ((status = 'filled') = (amount_out IS NOT NULL AND ts_fill IS NOT NULL)),
  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS candles_external_base_tick ON candles_external (base_unit, tick_ts);
```

- [ ] **Step 5: Run the guard; expect PASS. Then prove it red**

Run: `npx vitest run packages/db/test/noVolumeColumn.guard.test.ts` → 2 passed.
Reinject: add a line `  volume              numeric(38,0),` inside the `candles` DDL, rerun → first test FAILS. Remove the line, rerun → PASS. Paste both outputs in the commit body.

- [ ] **Step 6: Write the pg test**

`packages/db/test/candlesSchema.pg.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { PG_ENABLED, withTestSchema } from './helpers.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';

async function seedSnek(db: import('pg').Pool): Promise<void> {
  await db.query(
    `INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`,
    [SNEK],
  );
}

describe.skipIf(!PG_ENABLED)('0002_candles_engine', () => {
  it('applies after 0001 and creates the five tables', async () => {
    await withTestSchema(async (db) => {
      expect(await migrate(db)).toEqual(['0001_core.sql', '0002_candles_engine.sql']);
      const t = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1`,
      );
      expect(t.rows.map((r) => r.table_name)).toEqual([
        'candles', 'candles_external', 'collector_runs', 'external_pool_map', 'paper_orders', 'pool_snapshots', 'runs', 'schema_migrations', 'tokens',
      ]);
    });
  });

  it('paper_orders enforces the filled/rejected shape', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedSnek(db);
      const run = await db.query<{ id: string }>(
        `INSERT INTO runs (mode, strategy_id, git_sha, base_unit, data_source, fill_model, data_from, data_to)
         VALUES ('backtest', 'ma-crossover', 'abc', $1, 'candles', 'cpmm_observed', now(), now()) RETURNING id`,
        [SNEK],
      );
      const runId = run.rows[0]?.id;
      await expect(
        db.query(
          `INSERT INTO paper_orders (run_id, seq, ts_intent, base_unit, side, unit_in, amount_in, status, reason)
           VALUES ($1, 1, now(), $2, 'buy', 'lovelace', 1000, 'filled', 'test')`,
          [runId, SNEK],
        ),
      ).rejects.toThrow(/paper_orders_check/);
      await db.query(
        `INSERT INTO paper_orders (run_id, seq, ts_intent, base_unit, side, unit_in, amount_in, status, reject_reason, reason)
         VALUES ($1, 1, now(), $2, 'buy', 'lovelace', 1000, 'rejected', 'no t+1 candle', 'test')`,
        [runId, SNEK],
      );
    });
  });

  it('runs rejects an unknown fill model', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await seedSnek(db);
      await expect(
        db.query(
          `INSERT INTO runs (mode, strategy_id, git_sha, base_unit, data_source, fill_model, data_from, data_to)
           VALUES ('backtest', 'x', 'abc', $1, 'candles', 'flat_slippage', now(), now())`,
          [SNEK],
        ),
      ).rejects.toThrow(/runs_fill_model_check/);
    });
  });
});
```

- [ ] **Step 7: Run pg tests, lint, commit**

```bash
docker compose up -d postgres && npm run test:pg -- packages/db && npm run lint
git add -A && git commit -m "feat(db): migration 0002 — candles, external candles, pool map, runs, paper orders

noVolumeColumn guard proven red by injecting a volume column, then restored.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `@ctb/candles` — pure candle builder

**Files:**
- Create: `packages/candles/package.json`, `packages/candles/src/index.ts`, `packages/candles/src/types.ts`, `packages/candles/src/price.ts`, `packages/candles/src/build.ts`, `packages/candles/test/price.test.ts`, `packages/candles/test/build.test.ts`

**Interfaces:**
- Consumes: `SnapshotRow` shape from `@ctb/collector` (only the fields named below).
- Produces:
  - `type Decimal = string` (a base-10 decimal string; the only cross-package price type)
  - `priceAdaPerToken(reserveQuote: bigint, reserveBase: bigint, decimals: number): Decimal` (18 fractional digits, bigint arithmetic)
  - `decimalToNumber(d: Decimal): number` (for indicators only; never for amounts)
  - `interface SnapshotForCandle { tickTs: Date; poolId: string; reserveBase: bigint; reserveQuote: bigint; feeBps: number; poolType: 'cpmm'; tvlLovelace: bigint }`
  - `interface CandleRow { baseUnit: string; tickTs: Date; poolId: string; open: Decimal; high: Decimal; low: Decimal; close: Decimal; closeReserveBase: bigint; closeReserveQuote: bigint; feeBps: number; poolType: 'cpmm'; tvlLovelace: bigint; netFlowBase: bigint | null; netFlowQuote: bigint | null }`
  - `buildCandles(baseUnit: string, decimals: number, snapshots: SnapshotForCandle[], previous?: Pick<CandleRow, 'tickTs' | 'poolId' | 'closeReserveBase' | 'closeReserveQuote'>): CandleRow[]`
    - groups snapshots by `tickTs`, picks the pool with the largest `tvlLovelace` per tick (ties: lexicographically smallest `poolId`, so the choice is deterministic), emits one candle per tick in ascending order, `open=high=low=close` = price of that pool, net flows = reserve deltas vs the previous emitted candle **only when its `poolId` matches**, else `null`; `previous` seeds the first delta for incremental builds.
    - throws on a snapshot with `poolType !== 'cpmm'`, zero reserves, or a tick earlier than `previous.tickTs`.

- [ ] **Step 1: Package manifest**

`packages/candles/package.json`:
```json
{
  "name": "@ctb/candles",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": { "@ctb/collector": "*", "@ctb/db": "*", "@ctb/universe": "*", "pg": "^8.13.0" },
  "devDependencies": { "@types/pg": "^8.11.0" }
}
```
Run: `npm install`

- [ ] **Step 2: Write the failing tests**

`packages/candles/test/price.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { decimalToNumber, priceAdaPerToken } from '../src/index.js';

describe('priceAdaPerToken', () => {
  it('matches the live SundaeSwapV3 SNEK/ADA pool (0 decimals)', () => {
    const p = priceAdaPerToken(52_331_970_594n, 23_779_491n, 0);
    expect(p.startsWith('0.0022007187031042')).toBe(true);
    expect(p.split('.')[1]).toHaveLength(18);
  });

  it('scales by token decimals', () => {
    // 1 000 000 ADA of lovelace vs 2 000 000 000 000 of a 6-decimal token = 0.5 ADA per token
    expect(priceAdaPerToken(1_000_000_000_000n, 2_000_000_000_000n, 6)).toBe('0.500000000000000000');
    // same reserves, 0 decimals: 0.0000005 ADA per unit
    expect(priceAdaPerToken(1_000_000_000_000n, 2_000_000_000_000n, 0)).toBe('0.000000500000000000');
  });

  it('rejects zero reserves', () => {
    expect(() => priceAdaPerToken(0n, 1n, 0)).toThrow(/reserve/);
    expect(() => priceAdaPerToken(1n, 0n, 0)).toThrow(/reserve/);
  });

  it('decimalToNumber round-trips a normal price', () => {
    expect(decimalToNumber('0.500000000000000000')).toBeCloseTo(0.5, 12);
  });
});
```

`packages/candles/test/build.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildCandles, type SnapshotForCandle } from '../src/index.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const t = (m: number) => new Date(Date.UTC(2026, 8, 6, 12, m, 0));
const snap = (o: Partial<SnapshotForCandle> & { tickTs: Date; poolId: string }): SnapshotForCandle => ({
  reserveBase: 23_779_491n, reserveQuote: 52_331_970_594n, feeBps: 100, poolType: 'cpmm', tvlLovelace: 104_663_941_188n, ...o,
});

describe('buildCandles', () => {
  it('picks the deepest pool per tick and emits ascending candles with degenerate OHLC', () => {
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(5), poolId: 'MinswapV2:a', tvlLovelace: 500n, reserveBase: 100n, reserveQuote: 200n }),
      snap({ tickTs: t(0), poolId: 'SundaeSwapV3:b' }),
      snap({ tickTs: t(5), poolId: 'SundaeSwapV3:b', tvlLovelace: 104_663_941_188n }),
    ]);
    expect(rows.map((r) => r.tickTs)).toEqual([t(0), t(5)]);
    expect(rows[1]?.poolId).toBe('SundaeSwapV3:b');
    const c = rows[0]!;
    expect([c.open, c.high, c.low]).toEqual([c.close, c.close, c.close]);
    expect(c.close.startsWith('0.0022007187')).toBe(true);
    expect(c.closeReserveBase).toBe(23_779_491n);
  });

  it('net flow is the reserve delta against the previous candle of the same pool', () => {
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(0), poolId: 'p', reserveBase: 1_000n, reserveQuote: 2_000n }),
      snap({ tickTs: t(5), poolId: 'p', reserveBase: 900n, reserveQuote: 2_250n }),
    ]);
    expect(rows[0]?.netFlowBase).toBeNull();
    expect(rows[1]?.netFlowBase).toBe(-100n);
    expect(rows[1]?.netFlowQuote).toBe(250n);
  });

  it('a window where flows net to zero shows zero net flow (this is not volume)', () => {
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(0), poolId: 'p', reserveBase: 1_000n, reserveQuote: 2_000n }),
      snap({ tickTs: t(5), poolId: 'p', reserveBase: 1_000n, reserveQuote: 2_000n }),
    ]);
    expect(rows[1]?.netFlowBase).toBe(0n);
    expect(rows[1]?.netFlowQuote).toBe(0n);
    expect(Object.keys(rows[1]!)).not.toContain('volume');
  });

  it('nulls the flow when the deepest pool changes', () => {
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(0), poolId: 'p', tvlLovelace: 10n }),
      snap({ tickTs: t(5), poolId: 'q', tvlLovelace: 20n }),
    ]);
    expect(rows[1]?.poolId).toBe('q');
    expect(rows[1]?.netFlowBase).toBeNull();
  });

  it('seeds the first delta from `previous` for incremental builds', () => {
    const rows = buildCandles(SNEK, 0, [snap({ tickTs: t(5), poolId: 'p', reserveBase: 90n, reserveQuote: 210n })], {
      tickTs: t(0), poolId: 'p', closeReserveBase: 100n, closeReserveQuote: 200n,
    });
    expect(rows[0]?.netFlowBase).toBe(-10n);
    expect(rows[0]?.netFlowQuote).toBe(10n);
  });

  it('breaks ties deterministically on poolId', () => {
    const rows = buildCandles(SNEK, 0, [
      snap({ tickTs: t(0), poolId: 'Zed:1', tvlLovelace: 5n }),
      snap({ tickTs: t(0), poolId: 'Alpha:1', tvlLovelace: 5n }),
    ]);
    expect(rows[0]?.poolId).toBe('Alpha:1');
  });

  it('fails closed on bad input', () => {
    expect(() => buildCandles(SNEK, 0, [snap({ tickTs: t(0), poolId: 'p', poolType: 'stable' as 'cpmm' })])).toThrow(/pool_type/);
    expect(() => buildCandles(SNEK, 0, [snap({ tickTs: t(0), poolId: 'p', reserveBase: 0n })])).toThrow(/reserve/);
    expect(() => buildCandles(SNEK, 0, [snap({ tickTs: t(0), poolId: 'p' })], { tickTs: t(5), poolId: 'p', closeReserveBase: 1n, closeReserveQuote: 1n })).toThrow(/earlier/);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run packages/candles`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`packages/candles/src/types.ts`:
```ts
/** Base-10 decimal string. The only representation of a price that crosses a package boundary. */
export type Decimal = string;

export interface SnapshotForCandle {
  tickTs: Date;
  poolId: string;
  reserveBase: bigint;
  reserveQuote: bigint;
  feeBps: number;
  poolType: 'cpmm';
  tvlLovelace: bigint;
}

export interface CandleRow {
  baseUnit: string;
  tickTs: Date;
  poolId: string;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  closeReserveBase: bigint;
  closeReserveQuote: bigint;
  feeBps: number;
  poolType: 'cpmm';
  tvlLovelace: bigint;
  /** Reserve delta vs the previous candle of the SAME pool; null when the pool changed or there is no previous. */
  netFlowBase: bigint | null;
  netFlowQuote: bigint | null;
}
```

`packages/candles/src/price.ts`:
```ts
import type { Decimal } from './types.js';

export const PRICE_SCALE = 18;
const SCALE = 10n ** BigInt(PRICE_SCALE);
const LOVELACE_PER_ADA = 1_000_000n;

/** ADA per whole token = (reserveQuote / 1e6) / (reserveBase / 10^decimals), as an 18-place decimal string. */
export function priceAdaPerToken(reserveQuote: bigint, reserveBase: bigint, decimals: number): Decimal {
  if (reserveQuote <= 0n || reserveBase <= 0n) throw new Error(`price needs positive reserves, got quote=${reserveQuote} base=${reserveBase}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`decimals out of range: ${decimals}`);
  const scaled = (reserveQuote * 10n ** BigInt(decimals) * SCALE) / (reserveBase * LOVELACE_PER_ADA);
  return formatScaled(scaled);
}

export function formatScaled(scaled: bigint): Decimal {
  const s = scaled.toString().padStart(PRICE_SCALE + 1, '0');
  return `${s.slice(0, -PRICE_SCALE)}.${s.slice(-PRICE_SCALE)}`;
}

/** For indicators and reports only. Never use the result as an amount. */
export function decimalToNumber(d: Decimal): number {
  const n = Number(d);
  if (!Number.isFinite(n)) throw new Error(`not a finite decimal: ${d}`);
  return n;
}
```

`packages/candles/src/build.ts`:
```ts
import { priceAdaPerToken } from './price.js';
import type { CandleRow, SnapshotForCandle } from './types.js';

type Previous = Pick<CandleRow, 'tickTs' | 'poolId' | 'closeReserveBase' | 'closeReserveQuote'>;

/** Deepest pool per tick, one candle per tick, deterministic tie-break, net flows only within the same pool. */
export function buildCandles(baseUnit: string, decimals: number, snapshots: SnapshotForCandle[], previous?: Previous): CandleRow[] {
  const byTick = new Map<number, SnapshotForCandle[]>();
  for (const s of snapshots) {
    if (s.poolType !== 'cpmm') throw new Error(`pool_type ${String(s.poolType)} is not cpmm: ${s.poolId} @ ${s.tickTs.toISOString()}`);
    if (s.reserveBase <= 0n || s.reserveQuote <= 0n) throw new Error(`zero reserve: ${s.poolId} @ ${s.tickTs.toISOString()}`);
    if (previous && s.tickTs.getTime() <= previous.tickTs.getTime()) {
      throw new Error(`snapshot ${s.tickTs.toISOString()} is not later than previous candle ${previous.tickTs.toISOString()} (earlier or equal)`);
    }
    const k = s.tickTs.getTime();
    const list = byTick.get(k);
    if (list) list.push(s);
    else byTick.set(k, [s]);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  const out: CandleRow[] = [];
  let prev: Previous | undefined = previous;
  for (const k of ticks) {
    const deepest = [...(byTick.get(k) ?? [])].sort((a, b) => {
      if (a.tvlLovelace !== b.tvlLovelace) return a.tvlLovelace > b.tvlLovelace ? -1 : 1;
      return a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0;
    })[0];
    if (!deepest) continue;
    const price = priceAdaPerToken(deepest.reserveQuote, deepest.reserveBase, decimals);
    const samePool = prev !== undefined && prev.poolId === deepest.poolId;
    const row: CandleRow = {
      baseUnit,
      tickTs: deepest.tickTs,
      poolId: deepest.poolId,
      open: price, high: price, low: price, close: price,
      closeReserveBase: deepest.reserveBase,
      closeReserveQuote: deepest.reserveQuote,
      feeBps: deepest.feeBps,
      poolType: 'cpmm',
      tvlLovelace: deepest.tvlLovelace,
      netFlowBase: samePool && prev ? deepest.reserveBase - prev.closeReserveBase : null,
      netFlowQuote: samePool && prev ? deepest.reserveQuote - prev.closeReserveQuote : null,
    };
    out.push(row);
    prev = row;
  }
  return out;
}
```

`packages/candles/src/index.ts`:
```ts
export type { CandleRow, Decimal, SnapshotForCandle } from './types.js';
export { decimalToNumber, formatScaled, priceAdaPerToken, PRICE_SCALE } from './price.js';
export { buildCandles } from './build.js';
```

- [ ] **Step 5: Run tests, lint, commit**

Run: `npx vitest run packages/candles` → 11 passed. `npm run lint` clean.
```bash
git add -A && git commit -m "feat(candles): pure candle builder — deepest pool per tick, net flows, decimal prices

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `@ctb/candles` — Postgres repository and the `candles` CLI command

**Files:**
- Create: `packages/candles/src/repo.ts`, `packages/candles/test/repo.pg.test.ts`, `packages/cli/src/commands/candles.ts`
- Modify: `packages/candles/src/index.ts`, `packages/cli/src/main.ts` (add `candles` case + usage line), `packages/cli/package.json` (add `"@ctb/candles": "*"`), `package.json` (add script `"candles": "tsx packages/cli/src/main.ts candles"`)

**Interfaces:**
- Consumes: `Db` (`@ctb/db`), `TokenSpec` (`@ctb/universe`), `CandleRow`, `buildCandles`, `SnapshotForCandle`.
- Produces:
  - `interface CandleRepo { readSnapshotsSince(baseUnit: string, afterTick: Date | null): Promise<SnapshotForCandle[]>; lastCandle(baseUnit: string): Promise<Pick<CandleRow,'tickTs'|'poolId'|'closeReserveBase'|'closeReserveQuote'> | null>; insertCandles(rows: CandleRow[]): Promise<number>; readCandles(baseUnit: string, from: Date, to: Date): Promise<CandleRow[]> }`
  - `class PgCandleRepo implements CandleRepo { constructor(db: Db) }`
  - `buildCandlesForToken(repo: CandleRepo, token: Pick<TokenSpec,'unit'|'decimals'|'ticker'>): Promise<{ built: number; from: Date | null; to: Date | null }>` (incremental: reads snapshots after the last candle, builds with `previous`, inserts; idempotent)
  - CLI `candles [TICKER]`: builds for all universe tokens (or one), prints a table `ticker, built, from, to`.

- [ ] **Step 1: Write the failing pg test**

`packages/candles/test/repo.pg.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:pg -- packages/candles` → FAIL, `PgCandleRepo` not exported.

- [ ] **Step 3: Implement the repository and the builder driver**

`packages/candles/src/repo.ts`:
```ts
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
```

Add to `packages/candles/src/index.ts`:
```ts
export { buildCandlesForToken, PgCandleRepo, type CandleRepo } from './repo.js';
```

- [ ] **Step 4: CLI command**

`packages/cli/src/commands/candles.ts`:
```ts
import { buildCandlesForToken, PgCandleRepo } from '@ctb/candles';
import { createPool } from '@ctb/db';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

export async function candlesCommand(log: Logger, opts: { ticker?: string }): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: false });
  const universe = await loadUniverse();
  const tokens = opts.ticker ? universe.tokens.filter((t) => t.ticker === opts.ticker) : universe.tokens;
  if (tokens.length === 0) throw new Error(`unknown ticker ${opts.ticker ?? ''}; not in universe.json`);
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const repo = new PgCandleRepo(db);
    const out: Array<{ ticker: string; built: number; from: string; to: string }> = [];
    for (const t of tokens) {
      const r = await buildCandlesForToken(repo, t);
      out.push({ ticker: t.ticker, built: r.built, from: r.from?.toISOString() ?? '-', to: r.to?.toISOString() ?? '-' });
    }
    console.table(out);
  } finally {
    await db.end();
  }
}
```

In `packages/cli/src/main.ts` add `case 'candles': return candlesCommand(log, { ticker: rest[0] });` and extend the usage string to `<migrate|collect [--once]|status|candles [TICKER]>`. Add `"@ctb/candles": "*"` to `packages/cli/package.json` dependencies and the root script `"candles": "tsx packages/cli/src/main.ts candles"`. Run `npm install`.

- [ ] **Step 5: Verify end to end on compose (no key needed if snapshots exist; otherwise the table is empty and the command still succeeds)**

```bash
npm run test:pg -- packages/candles && npm test && npm run lint
npm run migrate && npm run candles
```
Expected: pg test passes; `candles` prints one row per token with `built` = number of new candles (0 when no snapshots yet).

- [ ] **Step 6: Commit, open PR `feat/m2-schema` → main (Tasks 1-3), wait for CI green, merge**

```bash
git add -A && git commit -m "feat(candles): postgres repo, incremental builder, candles CLI command

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/m2-schema
gh pr create --base main --title "M2 part 1: schema 0002, candle builder, candles command" --body "Plan 2 Tasks 1-3. Spec §4.3, §5."
```
After merge: `git checkout main && git pull --ff-only`. Every following task group branches from here.

---

### Task 4: `@ctb/candles` — GeckoTerminal client, pool matching, backfill, `backfill` command

**Files:**
- Create: `packages/candles/src/geckoTerminal.ts`, `packages/candles/src/externalRepo.ts`, `packages/candles/src/backfill.ts`, `packages/candles/test/geckoTerminal.test.ts`, `packages/candles/test/backfill.test.ts`, `packages/candles/test/externalRepo.pg.test.ts`, `packages/cli/src/commands/backfill.ts`
- Modify: `packages/candles/src/index.ts`, `packages/cli/src/main.ts`, `package.json` (script `"backfill": "tsx packages/cli/src/main.ts backfill"`)

**Interfaces:**
- Produces:
  - `interface GeckoPool { id: string; hex: string; name: string; dex: string; reserveUsd: number | null }`
  - `interface GeckoCandle { tickTs: Date; open: Decimal; high: Decimal; low: Decimal; close: Decimal; volumeQuote: Decimal }`
  - `class GeckoTerminalClient { constructor(opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; minSpacingMs?: number; log: Logger }); listAdaPools(unit: string): Promise<GeckoPool[]>; ohlcv5m(poolHex: string, beforeTs?: Date): Promise<GeckoCandle[]>; calls(): number }` — enforces ≥ `minSpacingMs` (default 3000) between calls; on 429 or 5xx retries with exponential backoff and jitter (base 5 s, max 60 s, 5 attempts) then throws.
  - `chooseExternalPool(pools: GeckoPool[], knownIdentifiers: string[]): { pool: GeckoPool; method: 'identifier' | 'pair_largest_reserve' } | null` — prefers a pool whose `hex` equals one of our Minswap v2 identifiers, else the ADA pool with the largest `reserveUsd`; null when no ADA pool.
  - `interface ExternalRepo { getMap(unit: string): Promise<{ externalPoolId: string; externalDex: string; matchMethod: string } | null>; putMap(m: { unit: string; externalPoolId: string; externalDex: string; matchMethod: 'identifier' | 'pair_largest_reserve'; reserveUsd: number | null }): Promise<void>; knownMinswapV2Identifiers(unit: string): Promise<string[]>; upsertExternal(unit: string, poolId: string, candles: GeckoCandle[]): Promise<number>; readExternal(unit: string, from: Date, to: Date): Promise<GeckoCandle[]>; coverage(unit: string): Promise<{ first: Date | null; last: Date | null; rows: number }> }`
  - `class PgExternalRepo implements ExternalRepo { constructor(db: Db) }`
  - `backfillToken(deps: { client: GeckoTerminalClient; repo: ExternalRepo; token: Pick<TokenSpec,'unit'|'ticker'>; from: Date; to: Date; log: Logger }): Promise<{ pages: number; rows: number; pool: string; method: string }>` — pages backwards from `to` with `before_timestamp` until the oldest row is `< from` or a page comes back empty; upserts each page; idempotent.
  - CLI `backfill <TICKER> <from-ISO> <to-ISO>`.

- [ ] **Step 1: Failing unit tests for the client and matcher (fake fetch, fake sleep, no network)**

`packages/candles/test/geckoTerminal.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { chooseExternalPool, GeckoTerminalClient, type GeckoPool } from '../src/index.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(responses: Array<() => Response>) {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra call');
    return next();
  }) as typeof fetch;
  return { f, calls };
}

const poolsBody = {
  data: [
    { id: 'cardano_aaa', attributes: { name: 'SNEK / ADA', address: 'aaa', reserve_in_usd: '100.5' }, relationships: { dex: { data: { id: 'minswap-cardano' } } } },
    { id: 'cardano_bbb', attributes: { name: 'NIGHT / SNEK', address: 'bbb', reserve_in_usd: '999' }, relationships: { dex: { data: { id: 'minswap-cardano' } } } },
    { id: 'cardano_ccc', attributes: { name: 'SNEK / ADA', address: 'ccc', reserve_in_usd: '50' }, relationships: { dex: { data: { id: 'saturnswap' } } } },
  ],
};

describe('GeckoTerminalClient', () => {
  it('lists only ADA pools, parses reserve, and spaces calls', async () => {
    const slept: number[] = [];
    const { f, calls } = fakeFetch([() => json(poolsBody), () => json(poolsBody)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async (ms) => { slept.push(ms); }, minSpacingMs: 3000, log });
    const pools = await c.listAdaPools('unit1');
    expect(pools.map((p) => p.hex)).toEqual(['aaa', 'ccc']);
    expect(pools[0]?.reserveUsd).toBe(100.5);
    expect(calls[0]).toContain('/networks/cardano/tokens/unit1/pools');
    await c.listAdaPools('unit1');
    expect(slept.length).toBe(1); // second call waited for the spacing window
    expect(c.calls()).toBe(2);
  });

  it('parses ohlcv rows into ascending decimal candles', async () => {
    const body = { data: { attributes: { ohlcv_list: [[1_788_692_700, 0.00218, 0.00223, 0.00218, 0.00222, 2272.72725], [1_788_692_400, 0.0021, 0.0022, 0.0021, 0.00218, 10]] } } };
    const { f, calls } = fakeFetch([() => json(body)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, log });
    const rows = await c.ohlcv5m('aaa', new Date(1_788_700_000 * 1000));
    expect(calls[0]).toContain('/pools/aaa/ohlcv/minute?aggregate=5&limit=1000&before_timestamp=1788700000');
    expect(rows.map((r) => r.tickTs.getTime() / 1000)).toEqual([1_788_692_400, 1_788_692_700]);
    expect(rows[1]?.close).toBe('0.00222');
    expect(rows[1]?.volumeQuote).toBe('2272.72725');
  });

  it('backs off on 429 and succeeds on a later attempt', async () => {
    const slept: number[] = [];
    const { f } = fakeFetch([() => json({}, 429), () => json({}, 429), () => json(poolsBody)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async (ms) => { slept.push(ms); }, minSpacingMs: 0, log });
    const pools = await c.listAdaPools('u');
    expect(pools).toHaveLength(2);
    expect(slept.length).toBe(2);
    expect(slept[0]).toBeGreaterThanOrEqual(5000);
    expect(slept[1]).toBeGreaterThan(slept[0]!);
  });

  it('gives up after 5 attempts with the status in the message', async () => {
    const { f } = fakeFetch(Array.from({ length: 5 }, () => () => json({}, 503)));
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, minSpacingMs: 0, log });
    await expect(c.listAdaPools('u')).rejects.toThrow(/503.*5 attempts/);
  });

  it('does not retry a 404', async () => {
    const { f, calls } = fakeFetch([() => json({}, 404)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, minSpacingMs: 0, log });
    await expect(c.ohlcv5m('nope')).rejects.toThrow(/404/);
    expect(calls).toHaveLength(1);
  });
});

describe('chooseExternalPool', () => {
  const pools: GeckoPool[] = [
    { id: 'cardano_aaa', hex: 'aaa', name: 'SNEK / ADA', dex: 'minswap-cardano', reserveUsd: 100 },
    { id: 'cardano_ccc', hex: 'ccc', name: 'SNEK / ADA', dex: 'saturnswap', reserveUsd: 500 },
  ];
  it('prefers an identifier match over a larger reserve', () => {
    expect(chooseExternalPool(pools, ['aaa'])).toEqual({ pool: pools[0], method: 'identifier' });
  });
  it('falls back to the largest reserve', () => {
    expect(chooseExternalPool(pools, ['zzz'])).toEqual({ pool: pools[1], method: 'pair_largest_reserve' });
  });
  it('returns null with no pools', () => {
    expect(chooseExternalPool([], [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run packages/candles/test/geckoTerminal.test.ts` → FAIL, not exported.

- [ ] **Step 3: Implement the client**

`packages/candles/src/geckoTerminal.ts`:
```ts
import type { Logger } from '@ctb/collector';
import type { Decimal } from './types.js';

export interface GeckoPool { id: string; hex: string; name: string; dex: string; reserveUsd: number | null }
export interface GeckoCandle { tickTs: Date; open: Decimal; high: Decimal; low: Decimal; close: Decimal; volumeQuote: Decimal }

export interface GeckoTerminalClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Free tier: five rapid calls returned 429 on 2026-09-06. */
  minSpacingMs?: number;
  baseUrl?: string;
  log: Logger;
  random?: () => number;
}

const RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export class GeckoTerminalClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spacing: number;
  private readonly base: string;
  private readonly log: Logger;
  private readonly random: () => number;
  private lastCallAt = 0;
  private count = 0;

  constructor(o: GeckoTerminalClientOptions) {
    this.fetchImpl = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.spacing = o.minSpacingMs ?? 3_000;
    this.base = o.baseUrl ?? 'https://api.geckoterminal.com/api/v2';
    this.log = o.log;
    this.random = o.random ?? Math.random;
  }

  calls(): number { return this.count; }

  async listAdaPools(unit: string): Promise<GeckoPool[]> {
    const body = (await this.get(`/networks/cardano/tokens/${unit}/pools?page=1`)) as {
      data?: Array<{ id: string; attributes: { name: string; address: string; reserve_in_usd: string | null }; relationships: { dex: { data: { id: string } } } }>;
    };
    return (body.data ?? [])
      .filter((p) => p.attributes.name.split(' / ').includes('ADA'))
      .map((p) => ({
        id: p.id, hex: p.attributes.address, name: p.attributes.name, dex: p.relationships.dex.data.id,
        reserveUsd: p.attributes.reserve_in_usd === null ? null : Number(p.attributes.reserve_in_usd),
      }));
  }

  async ohlcv5m(poolHex: string, beforeTs?: Date): Promise<GeckoCandle[]> {
    const before = beforeTs ? `&before_timestamp=${Math.floor(beforeTs.getTime() / 1000)}` : '';
    const body = (await this.get(`/networks/cardano/pools/${poolHex}/ohlcv/minute?aggregate=5&limit=1000${before}`)) as {
      data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
    };
    const list = body.data?.attributes?.ohlcv_list ?? [];
    return list
      .map(([ts, o, h, l, c, v]) => ({ tickTs: new Date(ts * 1000), open: String(o), high: String(h), low: String(l), close: String(c), volumeQuote: String(v) }))
      .sort((a, b) => a.tickTs.getTime() - b.tickTs.getTime());
  }

  private async get(path: string): Promise<unknown> {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      const wait = this.lastCallAt + this.spacing - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCallAt = Date.now();
      this.count++;
      const res = await this.fetchImpl(`${this.base}${path}`, { headers: { Accept: 'application/json;version=20230302' } });
      if (res.ok) return res.json();
      lastStatus = res.status;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient) throw new Error(`geckoterminal ${path} returned ${res.status}`);
      if (attempt === RETRY_ATTEMPTS) break;
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + Math.floor(this.random() * 1_000);
      this.log.warn({ path, status: res.status, attempt, backoffMs: backoff }, 'geckoterminal transient error, backing off');
      await this.sleep(backoff);
    }
    throw new Error(`geckoterminal ${path} returned ${lastStatus} after ${RETRY_ATTEMPTS} attempts`);
  }
}

/** Identifier match wins (our MinswapV2 pool_id suffix equals Gecko's hex); otherwise the deepest ADA pool. */
export function chooseExternalPool(
  pools: GeckoPool[],
  knownIdentifiers: string[],
): { pool: GeckoPool; method: 'identifier' | 'pair_largest_reserve' } | null {
  const byId = pools.find((p) => knownIdentifiers.includes(p.hex));
  if (byId) return { pool: byId, method: 'identifier' };
  const deepest = [...pools].sort((a, b) => (b.reserveUsd ?? -1) - (a.reserveUsd ?? -1))[0];
  return deepest ? { pool: deepest, method: 'pair_largest_reserve' } : null;
}
```

- [ ] **Step 4: Run the client tests** → 8 passed.

- [ ] **Step 5: Failing test for backfill (fake client and repo), then implement**

`packages/candles/test/backfill.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { backfillToken, type ExternalRepo, type GeckoCandle, type GeckoPool } from '../src/index.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const day = 86_400_000;
const t0 = Date.UTC(2026, 8, 1);
const candle = (ms: number): GeckoCandle => ({ tickTs: new Date(ms), open: '1', high: '1', low: '1', close: '1', volumeQuote: '0' });

class FakeClient {
  pages: GeckoCandle[][];
  requestedBefore: Array<Date | undefined> = [];
  constructor(pages: GeckoCandle[][]) { this.pages = pages; }
  async listAdaPools(): Promise<GeckoPool[]> { return [{ id: 'cardano_aaa', hex: 'aaa', name: 'X / ADA', dex: 'minswap-cardano', reserveUsd: 1 }]; }
  async ohlcv5m(_hex: string, before?: Date): Promise<GeckoCandle[]> { this.requestedBefore.push(before); return this.pages.shift() ?? []; }
  calls() { return this.requestedBefore.length; }
}

class FakeRepo implements ExternalRepo {
  map: Parameters<ExternalRepo['putMap']>[0] | null = null;
  rows = new Map<number, GeckoCandle>();
  async getMap() { return this.map ? { externalPoolId: this.map.externalPoolId, externalDex: this.map.externalDex, matchMethod: this.map.matchMethod } : null; }
  async putMap(m: Parameters<ExternalRepo['putMap']>[0]) { this.map = m; }
  async knownMinswapV2Identifiers() { return []; }
  async upsertExternal(_u: string, _p: string, candles: GeckoCandle[]) { let n = 0; for (const c of candles) { if (!this.rows.has(c.tickTs.getTime())) { this.rows.set(c.tickTs.getTime(), c); n++; } } return n; }
  async readExternal() { return [...this.rows.values()]; }
  async coverage() { return { first: null, last: null, rows: this.rows.size }; }
}

describe('backfillToken', () => {
  it('pages backwards until the window start, upserts, records the pool map', async () => {
    const page1 = [candle(t0 + 2 * day), candle(t0 + 3 * day)]; // newest page (ascending within page)
    const page2 = [candle(t0 - 1 * day), candle(t0 + 1 * day)]; // reaches below `from`
    const client = new FakeClient([page1, page2]);
    const repo = new FakeRepo();
    const r = await backfillToken({ client: client as never, repo, token: { unit: 'u', ticker: 'X' }, from: new Date(t0), to: new Date(t0 + 4 * day), log });
    expect(r).toEqual({ pages: 2, rows: 3, pool: 'aaa', method: 'pair_largest_reserve' });
    expect(client.requestedBefore[0]).toEqual(new Date(t0 + 4 * day));
    expect(client.requestedBefore[1]).toEqual(new Date(t0 + 2 * day)); // oldest row of page1
    expect([...repo.rows.keys()].sort()).toEqual([t0 + 1 * day, t0 + 2 * day, t0 + 3 * day]); // the row before `from` is dropped
    expect(repo.map?.matchMethod).toBe('pair_largest_reserve');
  });

  it('stops on an empty page and is idempotent', async () => {
    const repo = new FakeRepo();
    const c1 = new FakeClient([[candle(t0 + day)], []]);
    const r1 = await backfillToken({ client: c1 as never, repo, token: { unit: 'u', ticker: 'X' }, from: new Date(t0 - 10 * day), to: new Date(t0 + 4 * day), log });
    expect(r1.pages).toBe(2);
    const c2 = new FakeClient([[candle(t0 + day)], []]);
    const r2 = await backfillToken({ client: c2 as never, repo, token: { unit: 'u', ticker: 'X' }, from: new Date(t0 - 10 * day), to: new Date(t0 + 4 * day), log });
    expect(r2.rows).toBe(0);
  });

  it('fails closed when no ADA pool exists', async () => {
    const client = new FakeClient([]);
    client.listAdaPools = async () => [];
    await expect(backfillToken({ client: client as never, repo: new FakeRepo(), token: { unit: 'u', ticker: 'X' }, from: new Date(t0), to: new Date(t0 + day), log }))
      .rejects.toThrow(/no ADA pool on geckoterminal for X/);
  });
});
```

`packages/candles/src/backfill.ts`:
```ts
import type { Logger } from '@ctb/collector';
import type { TokenSpec } from '@ctb/universe';
import type { ExternalRepo } from './externalRepo.js';
import { chooseExternalPool, type GeckoCandle, type GeckoTerminalClient } from './geckoTerminal.js';

const MAX_PAGES = 400; // 400 pages x ~600 sparse rows covers well over a year at 5 minutes

export async function backfillToken(d: {
  client: Pick<GeckoTerminalClient, 'listAdaPools' | 'ohlcv5m'>;
  repo: ExternalRepo;
  token: Pick<TokenSpec, 'unit' | 'ticker'>;
  from: Date;
  to: Date;
  log: Logger;
}): Promise<{ pages: number; rows: number; pool: string; method: string }> {
  if (d.from.getTime() >= d.to.getTime()) throw new Error(`backfill window empty: ${d.from.toISOString()} >= ${d.to.toISOString()}`);
  let map = await d.repo.getMap(d.token.unit);
  if (!map) {
    const pools = await d.client.listAdaPools(d.token.unit);
    const chosen = chooseExternalPool(pools, await d.repo.knownMinswapV2Identifiers(d.token.unit));
    if (!chosen) throw new Error(`no ADA pool on geckoterminal for ${d.token.ticker} (${d.token.unit})`);
    await d.repo.putMap({ unit: d.token.unit, externalPoolId: chosen.pool.hex, externalDex: chosen.pool.dex, matchMethod: chosen.method, reserveUsd: chosen.pool.reserveUsd });
    map = { externalPoolId: chosen.pool.hex, externalDex: chosen.pool.dex, matchMethod: chosen.method };
    d.log.info({ ticker: d.token.ticker, pool: chosen.pool.hex, dex: chosen.pool.dex, method: chosen.method }, 'external pool chosen');
  }
  let before: Date | undefined = d.to;
  let pages = 0;
  let rows = 0;
  while (pages < MAX_PAGES) {
    const page: GeckoCandle[] = await d.client.ohlcv5m(map.externalPoolId, before);
    pages++;
    if (page.length === 0) break;
    const inWindow = page.filter((c) => c.tickTs.getTime() >= d.from.getTime() && c.tickTs.getTime() <= d.to.getTime());
    rows += await d.repo.upsertExternal(d.token.unit, map.externalPoolId, inWindow);
    const oldest = page[0]!.tickTs;
    if (oldest.getTime() < d.from.getTime()) break;
    before = oldest;
  }
  if (pages >= MAX_PAGES) d.log.warn({ ticker: d.token.ticker, pages }, 'backfill stopped at MAX_PAGES; window may be incomplete');
  return { pages, rows, pool: map.externalPoolId, method: map.matchMethod };
}
```

`packages/candles/src/externalRepo.ts`:
```ts
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
```

`packages/candles/test/externalRepo.pg.test.ts` (guarded): seed SNEK in `tokens`, `putMap` twice (second overwrites), `upsertExternal` two candles then the same two again (returns 0), `readExternal` returns them ascending with `volumeQuote` as the stored decimal string, `coverage` reports 2 rows, `knownMinswapV2Identifiers` returns `['abc']` after inserting one `MinswapV2:abc` snapshot via `PgSnapshotRepo`. Assert each with exact values.

Add to `packages/candles/src/index.ts`:
```ts
export { chooseExternalPool, GeckoTerminalClient, type GeckoCandle, type GeckoPool, type GeckoTerminalClientOptions } from './geckoTerminal.js';
export { PgExternalRepo, type ExternalPoolMap, type ExternalRepo } from './externalRepo.js';
export { backfillToken } from './backfill.js';
```

- [ ] **Step 6: CLI command**

`packages/cli/src/commands/backfill.ts`:
```ts
import { backfillToken, GeckoTerminalClient, PgExternalRepo } from '@ctb/candles';
import { createPool } from '@ctb/db';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

export function parseIsoDate(label: string, s: string | undefined): Date {
  const d = s ? new Date(s) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} must be an ISO date, got ${s ?? '(missing)'}`);
  return d;
}

export async function backfillCommand(log: Logger, args: string[]): Promise<void> {
  const [ticker, fromArg, toArg] = args;
  if (!ticker) throw new Error('usage: backfill <TICKER> <from-ISO> <to-ISO>');
  const from = parseIsoDate('from', fromArg);
  const to = parseIsoDate('to', toArg);
  const cfg = loadConfig(process.env, { blockfrost: false });
  const universe = await loadUniverse();
  const token = universe.tokens.find((t) => t.ticker === ticker);
  if (!token) throw new Error(`unknown ticker ${ticker}; not in universe.json`);
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const client = new GeckoTerminalClient({ log });
    const repo = new PgExternalRepo(db);
    const r = await backfillToken({ client, repo, token, from, to, log });
    const cov = await repo.coverage(token.unit);
    console.table([{ ticker, pool: r.pool, method: r.method, pages: r.pages, newRows: r.rows, calls: client.calls(),
      coverageFirst: cov.first?.toISOString() ?? '-', coverageLast: cov.last?.toISOString() ?? '-', coverageRows: cov.rows }]);
  } finally {
    await db.end();
  }
}
```
Wire `case 'backfill': return backfillCommand(log, rest);` in `main.ts`, extend usage, add the root script.

- [ ] **Step 7: Run everything, then one real backfill (network, no key)**

```bash
npx vitest run packages/candles && npm run test:pg -- packages/candles && npm test && npm run lint
npm run migrate && npm run backfill -- SNEK 2026-08-01T00:00:00Z 2026-09-01T00:00:00Z
```
Expected: the table shows `method: pair_largest_reserve` (no snapshots yet) or `identifier` (if the collector has run), a few pages, and `coverageRows` in the low thousands. Expect the command to take a couple of minutes because of the 3 s spacing; that is the rate limit, not a bug.

- [ ] **Step 8: Commit, PR `feat/m2-backfill` → main, CI green, merge**

```bash
git add -A && git commit -m "feat(candles): GeckoTerminal client with spacing and backoff, pool matching, backfill command

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `@ctb/engine` — indicators (pure)

**Files:**
- Create: `packages/engine/package.json`, `packages/engine/src/index.ts`, `packages/engine/src/indicators.ts`, `packages/engine/test/indicators.test.ts`

**Interfaces:**
- Produces (all pure, all over `number[]` oldest→newest, all return `null` while there is not enough data):
  - `sma(values: number[], period: number): number | null`
  - `ema(values: number[], period: number): number | null` (seeded with the SMA of the first `period` values, then `k = 2/(period+1)`)
  - `rsi(closes: number[], period: number): number | null` (Wilder: first average is a simple mean of the first `period` changes, then smoothed)
  - `pctChange(values: number[], lookback: number): number | null` (`last/valueLookbackAgo - 1`)
  - `spikeRatio(values: Array<number | null>, period: number): number | null` (last value divided by the SMA of the previous `period` non-null values; null if the last is null or fewer than `period` priors)
  - `crossed(fastPrev: number, slowPrev: number, fastNow: number, slowNow: number): 'up' | 'down' | null`

- [ ] **Step 1: Manifest**

`packages/engine/package.json`:
```json
{
  "name": "@ctb/engine",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": { "@ctb/candles": "*", "@ctb/collector": "*", "@ctb/db": "*", "@ctb/universe": "*", "pg": "^8.13.0" },
  "devDependencies": { "@types/pg": "^8.11.0" }
}
```
Run: `npm install`

- [ ] **Step 2: Failing tests**

`packages/engine/test/indicators.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { crossed, ema, pctChange, rsi, sma, spikeRatio } from '../src/index.js';

describe('indicators', () => {
  it('sma', () => {
    expect(sma([1, 2, 3, 4], 3)).toBe(3);
    expect(sma([1, 2], 3)).toBeNull();
  });
  it('ema seeds with sma then smooths (period 3, k=0.5)', () => {
    expect(ema([1, 2, 3], 3)).toBe(2);
    expect(ema([1, 2, 3, 4], 3)).toBe(3);
    expect(ema([1, 2], 3)).toBeNull();
  });
  it('rsi(3) on [10, 11, 10.5, 11.5] is 80 (hand computed: RS = (2/3)/(1/6) = 4)', () => {
    expect(rsi([10, 11, 10.5, 11.5], 3)).toBeCloseTo(80, 9);
  });
  it('rsi is 100 on a monotone rise and 0 on a monotone fall', () => {
    expect(rsi([1, 2, 3, 4, 5], 3)).toBe(100);
    expect(rsi([5, 4, 3, 2, 1], 3)).toBe(0);
  });
  it('rsi needs period+1 closes', () => {
    expect(rsi([1, 2, 3], 3)).toBeNull();
  });
  it('rsi smooths after the seed (Wilder)', () => {
    // seed over first 3 changes of [10,11,10.5,11.5] = gain 2/3, loss 1/6; next change +0.5:
    // gain = (2/3*2 + 0.5)/3 = 0.6111.., loss = (1/6*2 + 0)/3 = 0.1111.. ; RS = 5.5 ; RSI = 84.615..
    expect(rsi([10, 11, 10.5, 11.5, 12], 3)).toBeCloseTo(100 - 100 / 6.5, 9);
  });
  it('pctChange', () => {
    expect(pctChange([100, 110, 121], 2)).toBeCloseTo(0.21, 12);
    expect(pctChange([100], 1)).toBeNull();
  });
  it('spikeRatio ignores nulls in the baseline and requires a non-null last', () => {
    expect(spikeRatio([1, null, 1, 1, 3], 3)).toBe(3);
    expect(spikeRatio([1, 1, 1, null], 3)).toBeNull();
    expect(spikeRatio([1, 1, 3], 3)).toBeNull();
  });
  it('crossed', () => {
    expect(crossed(1, 2, 3, 2)).toBe('up');
    expect(crossed(3, 2, 1, 2)).toBe('down');
    expect(crossed(3, 2, 4, 2)).toBeNull();
    expect(crossed(2, 2, 3, 2)).toBe('up'); // touching then above counts as a cross
  });
});
```

- [ ] **Step 3: Run to verify failure**, then implement.

`packages/engine/src/indicators.ts`:
```ts
/** All inputs oldest -> newest. Null means "not enough data", never NaN. */

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i]!;
  return s / period;
}

export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let e = sma(values.slice(0, period), period)!;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

export function rsi(closes: number[], period: number): number | null {
  if (period <= 0 || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  if (gain === 0) return 0;
  return 100 - 100 / (1 + gain / loss);
}

export function pctChange(values: number[], lookback: number): number | null {
  if (lookback <= 0 || values.length <= lookback) return null;
  const then = values[values.length - 1 - lookback]!;
  if (then === 0) return null;
  return values[values.length - 1]! / then - 1;
}

export function spikeRatio(values: Array<number | null>, period: number): number | null {
  const last = values[values.length - 1];
  if (last === null || last === undefined) return null;
  const priors = values.slice(0, -1).filter((v): v is number => v !== null);
  const base = sma(priors, period);
  if (base === null || base === 0) return null;
  return last / base;
}

export function crossed(fastPrev: number, slowPrev: number, fastNow: number, slowNow: number): 'up' | 'down' | null {
  if (fastPrev <= slowPrev && fastNow > slowNow) return 'up';
  if (fastPrev >= slowPrev && fastNow < slowNow) return 'down';
  return null;
}
```

`packages/engine/src/index.ts` (for now):
```ts
export { crossed, ema, pctChange, rsi, sma, spikeRatio } from './indicators.js';
```

- [ ] **Step 4: Tests green, lint, commit**

Run: `npx vitest run packages/engine` → 10 passed; `npm run lint`.
```bash
git checkout -b feat/m2-engine origin/main   # after the backfill PR merged
git add -A && git commit -m "feat(engine): pure indicators (sma, ema, wilder rsi, pctChange, spikeRatio, crossed)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `@ctb/engine` — types, portfolio, event loop, reference strategy

**Files:**
- Create: `packages/engine/src/types.ts`, `packages/engine/src/portfolio.ts`, `packages/engine/src/loop.ts`, `packages/engine/src/strategies/maCrossover.ts`, `packages/engine/src/strategies/index.ts`, `packages/engine/test/portfolio.test.ts`, `packages/engine/test/loop.test.ts`, `packages/engine/test/maCrossover.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces:
  - `interface Candle { tickTs: Date; open: Decimal; high: Decimal; low: Decimal; close: Decimal; volumeQuote: Decimal | null; poolId: string | null; poolType: 'cpmm' | null; feeBps: number | null; closeReserveBase: bigint | null; closeReserveQuote: bigint | null; tvlLovelace: bigint | null }` — source-agnostic; local candles fill the reserve fields, external candles fill `volumeQuote`.
  - `interface Intent { side: 'buy' | 'sell'; amountIn: bigint; reason: string }` — buy: `amountIn` in lovelace; sell: `amountIn` in base smallest units.
  - `interface Portfolio { cashLovelace: bigint; positionBase: bigint }`
  - `interface StrategyContext { candle: Candle; history: Candle[]; closes: number[]; portfolio: Readonly<Portfolio>; params: Record<string, number> }` — `history` and `closes` are oldest→newest and include the current candle; `closes` are `decimalToNumber(close)`.
  - `interface Strategy { id: string; warmup: number; defaultParams: Record<string, number>; onCandle(ctx: StrategyContext): Intent[] }`
  - `type FillResult = { status: 'filled'; poolId: string; unitIn: string; amountIn: bigint; unitOut: string; amountOut: bigint; midPrice: Decimal; fillPrice: Decimal; poolFeeIn: bigint; batcherFeeLovelace: bigint; networkFeeLovelace: bigint; slippageBps: number; tsFill: Date } | { status: 'rejected'; reason: string }`
  - `interface Executor { fill(intent: Intent, at: Candle, next: Candle, portfolio: Readonly<Portfolio>): FillResult }` — synchronous and pure given its inputs.
  - `interface OrderRecord { seq: number; tsIntent: Date; intent: Intent; result: FillResult }`
  - `interface EquityPoint { tickTs: Date; cashLovelace: bigint; positionBase: bigint; equityLovelace: bigint; price: Decimal }`
  - `interface RunResult { orders: OrderRecord[]; equity: EquityPoint[]; final: Portfolio; summary: RunSummaryStats }`
  - `interface RunSummaryStats { candles: number; intents: number; filled: number; rejected: number; startEquityLovelace: string; endEquityLovelace: string; returnPct: number; maxDrawdownPct: number; feesLovelace: string; poolFeesIn: string; rejectReasons: Record<string, number> }`
  - `applyFill(p: Portfolio, r: Extract<FillResult,{status:'filled'}>, side: 'buy'|'sell'): Portfolio` (throws if it would go negative; the executor is expected to have checked)
  - `equityLovelace(p: Portfolio, price: Decimal, decimals: number): bigint`
  - `runEngine(deps: { feed: Iterable<Candle> | AsyncIterable<Candle>; strategy: Strategy; params?: Record<string, number>; executor: Executor; initial: Portfolio; decimals: number; log: Logger; historyLimit?: number }): Promise<RunResult>`
  - `maCrossover: Strategy` with `defaultParams { fast: 12, slow: 48, fraction: 0.5 }` and id `ma-crossover`: on an up-cross buy with `fraction` of cash (lovelace, floored, only if ≥ 5 ADA); on a down-cross sell the whole position (if > 0). Plumbing proof only; not a recommendation.
  - `STRATEGIES: Record<string, Strategy>`

Engine rule: intents produced at candle `t` are filled against candle `t+1` when it arrives; the last candle's intents are recorded as rejected with reason `no t+1 candle`. `runEngine` calls `strategy.onCandle` only once `history.length >= warmup`. The loop never calls `Date.now()`; `tsFill` comes from the executor (which uses `next.tickTs`).

- [ ] **Step 1: Failing tests**

`packages/engine/test/portfolio.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { applyFill, equityLovelace, type FillResult } from '../src/index.js';

const filled = (o: Partial<Extract<FillResult, { status: 'filled' }>>): Extract<FillResult, { status: 'filled' }> => ({
  status: 'filled', poolId: 'p', unitIn: 'lovelace', amountIn: 1_000_000_000n, unitOut: 'snek', amountOut: 441_500n, midPrice: '0.0022', fillPrice: '0.0022650',
  poolFeeIn: 10_000_000n, batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n, slippageBps: 292, tsFill: new Date(0), ...o,
});

describe('portfolio', () => {
  it('buy debits amountIn plus lovelace fees and credits the position', () => {
    const p = applyFill({ cashLovelace: 5_000_000_000n, positionBase: 0n }, filled({}), 'buy');
    expect(p).toEqual({ cashLovelace: 5_000_000_000n - 1_000_000_000n - 2_200_000n, positionBase: 441_500n });
  });
  it('sell debits the position and credits amountOut minus lovelace fees', () => {
    const p = applyFill({ cashLovelace: 0n, positionBase: 1_000_000n }, filled({ unitIn: 'snek', amountIn: 1_000_000n, unitOut: 'lovelace', amountOut: 2_091_631_632n }), 'sell');
    expect(p).toEqual({ cashLovelace: 2_091_631_632n - 2_200_000n, positionBase: 0n });
  });
  it('refuses to go negative', () => {
    expect(() => applyFill({ cashLovelace: 1n, positionBase: 0n }, filled({}), 'buy')).toThrow(/negative/);
  });
  it('equity values the position at the given price', () => {
    // 441 500 SNEK (0 decimals) at 0.0022 ADA = 971.3 ADA = 971 300 000 lovelace
    expect(equityLovelace({ cashLovelace: 100n, positionBase: 441_500n }, '0.002200000000000000', 0)).toBe(971_300_100n);
    // 6-decimal token: 2.5 tokens at 0.5 ADA = 1.25 ADA
    expect(equityLovelace({ cashLovelace: 0n, positionBase: 2_500_000n }, '0.500000000000000000', 6)).toBe(1_250_000n);
  });
});
```

`packages/engine/test/loop.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runEngine, type Candle, type Executor, type FillResult, type Intent, type Strategy } from '../src/index.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const c = (i: number, close: string): Candle => ({
  tickTs: new Date(Date.UTC(2026, 8, 6, 0, 5 * i)), open: close, high: close, low: close, close, volumeQuote: null,
  poolId: 'p', poolType: 'cpmm', feeBps: 30, closeReserveBase: 1_000_000n, closeReserveQuote: 1_000_000_000n, tvlLovelace: 2_000_000_000n,
});

/** Fills at next.close with no fees; enough to test the loop's mechanics. */
const passthrough: Executor = {
  fill(intent, _at, next): FillResult {
    const px = Number(next.close);
    const out = intent.side === 'buy' ? BigInt(Math.floor(Number(intent.amountIn) / px / 1e6)) : BigInt(Math.floor(Number(intent.amountIn) * px * 1e6));
    return { status: 'filled', poolId: 'p', unitIn: intent.side === 'buy' ? 'lovelace' : 'base', amountIn: intent.amountIn, unitOut: intent.side === 'buy' ? 'base' : 'lovelace',
      amountOut: out, midPrice: _at.close, fillPrice: next.close, poolFeeIn: 0n, batcherFeeLovelace: 0n, networkFeeLovelace: 0n, slippageBps: 0, tsFill: next.tickTs };
  },
};

const buyOnceThenSell: Strategy = {
  id: 'test', warmup: 2, defaultParams: {},
  onCandle(ctx): Intent[] {
    if (ctx.history.length === 2 && ctx.portfolio.positionBase === 0n) return [{ side: 'buy', amountIn: 100_000_000n, reason: 'first' }];
    if (ctx.history.length === 4 && ctx.portfolio.positionBase > 0n) return [{ side: 'sell', amountIn: ctx.portfolio.positionBase, reason: 'exit' }];
    return [];
  },
};

describe('runEngine', () => {
  it('fills intents at t+1, respects warmup, rejects the last candle intents, and summarizes', async () => {
    const feed = [c(0, '1.0'), c(1, '1.0'), c(2, '2.0'), c(3, '2.0'), c(4, '4.0'), c(5, '4.0')];
    const r = await runEngine({ feed, strategy: buyOnceThenSell, executor: passthrough, initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log });
    expect(r.orders).toHaveLength(2);
    expect(r.orders[0]?.tsIntent).toEqual(feed[1]!.tickTs); // decided on candle index 1 (warmup 2)
    expect(r.orders[0]?.result.status).toBe('filled');
    expect((r.orders[0]?.result as { tsFill: Date }).tsFill).toEqual(feed[2]!.tickTs); // filled on t+1
    expect(r.orders[0]?.seq).toBe(1);
    expect(r.orders[1]?.intent.side).toBe('sell');
    expect(r.final.positionBase).toBe(0n);
    expect(r.equity).toHaveLength(6);
    expect(r.summary.candles).toBe(6);
    expect(r.summary.filled).toBe(2);
    expect(r.summary.returnPct).toBeGreaterThan(0); // bought at 2.0, sold at 4.0
    expect(r.summary.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it('records a rejected order when there is no t+1 candle', async () => {
    const s: Strategy = { id: 'late', warmup: 1, defaultParams: {}, onCandle: (ctx) => (ctx.history.length === 2 ? [{ side: 'buy', amountIn: 1n, reason: 'late' }] : []) };
    const r = await runEngine({ feed: [c(0, '1'), c(1, '1')], strategy: s, executor: passthrough, initial: { cashLovelace: 10n, positionBase: 0n }, decimals: 0, log });
    expect(r.orders[0]?.result).toEqual({ status: 'rejected', reason: 'no t+1 candle' });
    expect(r.summary.rejectReasons).toEqual({ 'no t+1 candle': 1 });
  });

  it('is deterministic: two runs produce identical orders and equity', async () => {
    const feed = Array.from({ length: 40 }, (_, i) => c(i, (1 + 0.1 * Math.sin(i / 3)).toFixed(6)));
    const run = () => runEngine({ feed, strategy: buyOnceThenSell, executor: passthrough, initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log });
    const [a, b] = await Promise.all([run(), run()]);
    const ser = (r: Awaited<ReturnType<typeof run>>) => JSON.stringify({ o: r.orders, e: r.equity }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(ser(a)).toBe(ser(b));
  });

  it('trims history to historyLimit', async () => {
    let maxSeen = 0;
    const s: Strategy = { id: 'h', warmup: 1, defaultParams: {}, onCandle: (ctx) => { maxSeen = Math.max(maxSeen, ctx.history.length); return []; } };
    await runEngine({ feed: Array.from({ length: 30 }, (_, i) => c(i, '1')), strategy: s, executor: passthrough, initial: { cashLovelace: 0n, positionBase: 0n }, decimals: 0, log, historyLimit: 10 });
    expect(maxSeen).toBe(10);
  });
});
```

`packages/engine/test/maCrossover.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { maCrossover, type Candle, type StrategyContext } from '../src/index.js';

const candle = (close: string): Candle => ({ tickTs: new Date(0), open: close, high: close, low: close, close, volumeQuote: null, poolId: null, poolType: null, feeBps: null,
  closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null });
const ctxFor = (closes: number[], cash: bigint, pos: bigint): StrategyContext => ({
  candle: candle(String(closes.at(-1))), history: closes.map((x) => candle(String(x))), closes, portfolio: { cashLovelace: cash, positionBase: pos }, params: { fast: 2, slow: 3, fraction: 0.5 },
});

describe('maCrossover', () => {
  it('buys half the cash on an up-cross', () => {
    // fast(2)/slow(3): prev closes [3,2,1,2] -> fast 1.5 slow 1.67 (below); now [3,2,1,2,4] -> fast 3 slow 2.33 (above)
    const out = maCrossover.onCandle(ctxFor([3, 2, 1, 2, 4], 100_000_000n, 0n));
    expect(out).toEqual([{ side: 'buy', amountIn: 50_000_000n, reason: 'ma up-cross fast=2 slow=3' }]);
  });
  it('sells the whole position on a down-cross', () => {
    const out = maCrossover.onCandle(ctxFor([1, 2, 3, 2, 0.5], 0n, 777n));
    expect(out).toEqual([{ side: 'sell', amountIn: 777n, reason: 'ma down-cross fast=2 slow=3' }]);
  });
  it('does nothing without a cross, below the 5 ADA floor, or with nothing to sell', () => {
    expect(maCrossover.onCandle(ctxFor([1, 2, 3, 4, 5], 100_000_000n, 0n))).toEqual([]);
    expect(maCrossover.onCandle(ctxFor([3, 2, 1, 2, 4], 8_000_000n, 0n))).toEqual([]); // half of 8 ADA < 5 ADA
    expect(maCrossover.onCandle(ctxFor([1, 2, 3, 2, 0.5], 0n, 0n))).toEqual([]);
  });
  it('declares warmup = slow + 1 from defaults', () => {
    expect(maCrossover.warmup).toBe(49);
    expect(maCrossover.defaultParams).toEqual({ fast: 12, slow: 48, fraction: 0.5 });
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement.

`packages/engine/src/types.ts`:
```ts
import type { Decimal } from '@ctb/candles';

export interface Candle {
  tickTs: Date; open: Decimal; high: Decimal; low: Decimal; close: Decimal;
  volumeQuote: Decimal | null;
  poolId: string | null; poolType: 'cpmm' | null; feeBps: number | null;
  closeReserveBase: bigint | null; closeReserveQuote: bigint | null; tvlLovelace: bigint | null;
}
export interface Intent { side: 'buy' | 'sell'; amountIn: bigint; reason: string }
export interface Portfolio { cashLovelace: bigint; positionBase: bigint }
export interface StrategyContext { candle: Candle; history: Candle[]; closes: number[]; portfolio: Readonly<Portfolio>; params: Record<string, number> }
export interface Strategy { id: string; warmup: number; defaultParams: Record<string, number>; onCandle(ctx: StrategyContext): Intent[] }
export type FillResult =
  | { status: 'filled'; poolId: string; unitIn: string; amountIn: bigint; unitOut: string; amountOut: bigint; midPrice: Decimal; fillPrice: Decimal;
      poolFeeIn: bigint; batcherFeeLovelace: bigint; networkFeeLovelace: bigint; slippageBps: number; tsFill: Date }
  | { status: 'rejected'; reason: string };
export interface Executor { fill(intent: Intent, at: Candle, next: Candle, portfolio: Readonly<Portfolio>): FillResult }
export interface OrderRecord { seq: number; tsIntent: Date; intent: Intent; result: FillResult }
export interface EquityPoint { tickTs: Date; cashLovelace: bigint; positionBase: bigint; equityLovelace: bigint; price: Decimal }
export interface RunSummaryStats {
  candles: number; intents: number; filled: number; rejected: number;
  startEquityLovelace: string; endEquityLovelace: string; returnPct: number; maxDrawdownPct: number;
  feesLovelace: string; poolFeesIn: string; rejectReasons: Record<string, number>;
}
export interface RunResult { orders: OrderRecord[]; equity: EquityPoint[]; final: Portfolio; summary: RunSummaryStats }
```

`packages/engine/src/portfolio.ts`:
```ts
import { PRICE_SCALE, type Decimal } from '@ctb/candles';
import type { FillResult, Portfolio } from './types.js';

type Filled = Extract<FillResult, { status: 'filled' }>;

export function applyFill(p: Portfolio, r: Filled, side: 'buy' | 'sell'): Portfolio {
  const lovelaceFees = r.batcherFeeLovelace + r.networkFeeLovelace;
  const next: Portfolio = side === 'buy'
    ? { cashLovelace: p.cashLovelace - r.amountIn - lovelaceFees, positionBase: p.positionBase + r.amountOut }
    : { cashLovelace: p.cashLovelace + r.amountOut - lovelaceFees, positionBase: p.positionBase - r.amountIn };
  if (next.cashLovelace < 0n || next.positionBase < 0n) throw new Error(`fill would make the portfolio negative: cash=${next.cashLovelace} position=${next.positionBase}`);
  return next;
}

/** price is ADA per whole token as an 18-place decimal; position is in smallest units. */
export function equityLovelace(p: Portfolio, price: Decimal, decimals: number): bigint {
  const [intPart, frac = ''] = price.split('.');
  const scaled = BigInt(intPart + frac.padEnd(PRICE_SCALE, '0').slice(0, PRICE_SCALE)); // price * 1e18
  const positionValue = (p.positionBase * scaled * 1_000_000n) / (10n ** BigInt(decimals) * 10n ** BigInt(PRICE_SCALE));
  return p.cashLovelace + positionValue;
}
```

`packages/engine/src/loop.ts`:
```ts
import { decimalToNumber } from '@ctb/candles';
import type { Logger } from '@ctb/collector';
import { applyFill, equityLovelace } from './portfolio.js';
import type { Candle, EquityPoint, Executor, Intent, OrderRecord, Portfolio, RunResult, RunSummaryStats, Strategy } from './types.js';

export interface RunEngineDeps {
  feed: Iterable<Candle> | AsyncIterable<Candle>;
  strategy: Strategy;
  params?: Record<string, number>;
  executor: Executor;
  initial: Portfolio;
  decimals: number;
  log: Logger;
  historyLimit?: number;
}

/** One loop for backtest and paper: intents from candle t are filled against candle t+1. */
export async function runEngine(d: RunEngineDeps): Promise<RunResult> {
  const params = { ...d.strategy.defaultParams, ...(d.params ?? {}) };
  const historyLimit = d.historyLimit ?? Math.max(d.strategy.warmup * 4, 64);
  const history: Candle[] = [];
  const closes: number[] = [];
  const orders: OrderRecord[] = [];
  const equity: EquityPoint[] = [];
  let portfolio: Portfolio = { ...d.initial };
  let pending: Array<{ tsIntent: Date; at: Candle; intent: Intent }> = [];
  let seq = 0;
  let candles = 0;

  for await (const candle of d.feed as AsyncIterable<Candle>) {
    candles++;
    // 1. settle what was decided on the previous candle
    for (const p of pending) {
      seq++;
      const result = d.executor.fill(p.intent, p.at, candle, portfolio);
      if (result.status === 'filled') portfolio = applyFill(portfolio, result, p.intent.side);
      orders.push({ seq, tsIntent: p.tsIntent, intent: p.intent, result });
    }
    pending = [];
    // 2. observe
    history.push(candle);
    closes.push(decimalToNumber(candle.close));
    if (history.length > historyLimit) { history.shift(); closes.shift(); }
    equity.push({ tickTs: candle.tickTs, cashLovelace: portfolio.cashLovelace, positionBase: portfolio.positionBase, equityLovelace: equityLovelace(portfolio, candle.close, d.decimals), price: candle.close });
    // 3. decide
    if (history.length >= d.strategy.warmup) {
      const intents = d.strategy.onCandle({ candle, history: [...history], closes: [...closes], portfolio, params });
      for (const intent of intents) {
        if (intent.amountIn <= 0n) throw new Error(`strategy ${d.strategy.id} emitted a non-positive amountIn`);
        pending.push({ tsIntent: candle.tickTs, at: candle, intent });
      }
    }
  }
  for (const p of pending) {
    seq++;
    orders.push({ seq, tsIntent: p.tsIntent, intent: p.intent, result: { status: 'rejected', reason: 'no t+1 candle' } });
  }
  const summary = summarize(orders, equity, candles);
  d.log.info({ strategy: d.strategy.id, ...summary }, 'engine run finished');
  return { orders, equity, final: portfolio, summary };
}

export function summarize(orders: OrderRecord[], equity: EquityPoint[], candles: number): RunSummaryStats {
  const start = equity[0]?.equityLovelace ?? 0n;
  const end = equity.at(-1)?.equityLovelace ?? 0n;
  let peak = 0n;
  let maxDd = 0;
  for (const e of equity) {
    if (e.equityLovelace > peak) peak = e.equityLovelace;
    if (peak > 0n) {
      const dd = Number((peak - e.equityLovelace) * 10_000n / peak) / 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  let fees = 0n;
  let poolFees = 0n;
  const rejectReasons: Record<string, number> = {};
  let filled = 0;
  for (const o of orders) {
    if (o.result.status === 'filled') { filled++; fees += o.result.batcherFeeLovelace + o.result.networkFeeLovelace; poolFees += o.result.poolFeeIn; }
    else rejectReasons[o.result.reason] = (rejectReasons[o.result.reason] ?? 0) + 1;
  }
  return {
    candles, intents: orders.length, filled, rejected: orders.length - filled,
    startEquityLovelace: start.toString(), endEquityLovelace: end.toString(),
    returnPct: start > 0n ? Number((end - start) * 10_000n / start) / 100 : 0,
    maxDrawdownPct: maxDd, feesLovelace: fees.toString(), poolFeesIn: poolFees.toString(), rejectReasons,
  };
}
```

`packages/engine/src/strategies/maCrossover.ts`:
```ts
import { crossed, sma } from '../indicators.js';
import type { Intent, Strategy, StrategyContext } from '../types.js';

const MIN_BUY_LOVELACE = 5_000_000n;

/** Plumbing proof: moving-average crossover. Not a recommendation. */
export const maCrossover: Strategy = {
  id: 'ma-crossover',
  defaultParams: { fast: 12, slow: 48, fraction: 0.5 },
  warmup: 49,
  onCandle(ctx: StrategyContext): Intent[] {
    const fast = ctx.params.fast ?? 12;
    const slow = ctx.params.slow ?? 48;
    const fraction = ctx.params.fraction ?? 0.5;
    const now = ctx.closes;
    const prev = now.slice(0, -1);
    const fNow = sma(now, fast); const sNow = sma(now, slow);
    const fPrev = sma(prev, fast); const sPrev = sma(prev, slow);
    if (fNow === null || sNow === null || fPrev === null || sPrev === null) return [];
    const x = crossed(fPrev, sPrev, fNow, sNow);
    if (x === 'up' && ctx.portfolio.positionBase === 0n) {
      const amountIn = (ctx.portfolio.cashLovelace * BigInt(Math.round(fraction * 10_000))) / 10_000n;
      return amountIn >= MIN_BUY_LOVELACE ? [{ side: 'buy', amountIn, reason: `ma up-cross fast=${fast} slow=${slow}` }] : [];
    }
    if (x === 'down' && ctx.portfolio.positionBase > 0n) {
      return [{ side: 'sell', amountIn: ctx.portfolio.positionBase, reason: `ma down-cross fast=${fast} slow=${slow}` }];
    }
    return [];
  },
};
```

`packages/engine/src/strategies/index.ts`:
```ts
import type { Strategy } from '../types.js';
import { maCrossover } from './maCrossover.js';
export const STRATEGIES: Record<string, Strategy> = { [maCrossover.id]: maCrossover };
export { maCrossover };
```

Replace `packages/engine/src/index.ts`:
```ts
export { crossed, ema, pctChange, rsi, sma, spikeRatio } from './indicators.js';
export type { Candle, EquityPoint, Executor, FillResult, Intent, OrderRecord, Portfolio, RunResult, RunSummaryStats, Strategy, StrategyContext } from './types.js';
export { applyFill, equityLovelace } from './portfolio.js';
export { runEngine, summarize, type RunEngineDeps } from './loop.js';
export { maCrossover, STRATEGIES } from './strategies/index.js';
```

Note on the up-cross test: with `ctxFor` the previous window is `[3,2,1,2]` → fast(2) = 1.5, slow(3) = 1.667 (fast below); the current `[3,2,1,2,4]` → fast 3, slow 2.333 (fast above): an up-cross. The down-cross case: `[1,2,3,2]` → fast 2.5, slow 2.333 (above); `[1,2,3,2,0.5]` → fast 1.25, slow 1.833 (below).

- [ ] **Step 3: Tests green (4 + 4 + 4 = 12 new), lint, commit**

```bash
npx vitest run packages/engine && npm run lint
git add -A && git commit -m "feat(engine): candle/intent/portfolio types, single event loop with t+1 settlement, ma-crossover reference strategy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `@ctb/sim-executor` — constant-product fill at t+1 with Cardano costs

**Files:**
- Create: `packages/sim-executor/package.json`, `packages/sim-executor/src/index.ts`, `packages/sim-executor/src/cpmm.ts`, `packages/sim-executor/src/costs.ts`, `packages/sim-executor/src/simExecutor.ts`, `packages/sim-executor/test/cpmm.test.ts`, `packages/sim-executor/test/simExecutor.test.ts`

**Interfaces:**
- Consumes: `Candle`, `Executor`, `FillResult`, `Intent`, `Portfolio` from `@ctb/engine`; `formatScaled`, `PRICE_SCALE`, `Decimal` from `@ctb/candles`.
- Produces:
  - `cpmmAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint` (bigint only; throws on non-positive reserves, negative amount, or fee outside 0..9999)
  - `poolFeeTaken(amountIn: bigint, feeBps: number): bigint` (`amountIn * feeBps / 10000`, floored)
  - `interface VenueCosts { batcherFeeLovelace: bigint; networkFeeLovelace: bigint }`
  - `DEFAULT_COSTS: VenueCosts` = `{ batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n }` and `VENUE_COSTS: Record<DexName, VenueCosts>` all equal to the default. **ASSUMPTION, labeled in the file header:** batcher/agent/scooper fees differ per DEX and change over time; Task 11 verifies each against the venue's published fee and records the values used in every `runs.params`.
  - `costsForPoolId(poolId: string, overrides?: Partial<VenueCosts>): VenueCosts` (venue = prefix before `:`; unknown venue throws)
  - `type FillModel = { kind: 'cpmm_observed' } | { kind: 'cpmm_synthetic_depth'; depthLovelace: bigint }`
  - `class SimExecutor implements Executor { constructor(opts: { decimals: number; fillModel: FillModel; costOverrides?: Partial<VenueCosts> }); fill(intent, at, next, portfolio): FillResult }`
    - `cpmm_observed`: requires `next.poolType === 'cpmm'`, `next.closeReserveBase/Quote` positive, `next.feeBps` non-null, `next.poolId`; otherwise `rejected` with reason `no reserves at t+1` / `pool_type <x> not cpmm` / `no pool at t+1`.
    - `cpmm_synthetic_depth`: builds reserves from `next.close` and the declared depth: `reserveQuote = depthLovelace`, `reserveBase = depthLovelace * 10^decimals / (price * 1e6)` in bigint via the 18-place scaled price; fee = `next.feeBps ?? 30`; poolId = `next.poolId ?? 'synthetic'`. Used only when candles come from `candles_external`.
    - Both: buy = `amountIn` lovelace → base; sell = `amountIn` base → lovelace. Rejects when the portfolio cannot cover `amountIn` plus lovelace fees (`insufficient cash` / `insufficient position`) or when `amountOut` is 0 (`dust`). `midPrice` = `at.close`; `fillPrice` = amount-based price in ADA per whole token (`formatScaled`); `slippageBps` = `round((fill/mid − 1)·10000)` for buys and `round((1 − fill/mid)·10000)` for sells, computed on the raw lovelace-per-unit ratios; `tsFill = next.tickTs`.

- [ ] **Step 1: Manifest**

`packages/sim-executor/package.json`:
```json
{
  "name": "@ctb/sim-executor",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": { "@ctb/candles": "*", "@ctb/collector": "*", "@ctb/engine": "*" }
}
```
Run: `npm install`

- [ ] **Step 2: Failing tests with the hand-computed constants**

`packages/sim-executor/test/cpmm.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { cpmmAmountOut, poolFeeTaken } from '../src/index.js';

// Live SundaeSwapV3 SNEK/ADA pool, 2026-09-05: quote (lovelace) 52 331 970 594, base (SNEK, 0 dec) 23 779 491, fee 100 bps.
const RQ = 52_331_970_594n;
const RB = 23_779_491n;

describe('cpmmAmountOut', () => {
  it('buying with 1000 ADA yields 441 500 SNEK', () => {
    expect(cpmmAmountOut(1_000_000_000n, RQ, RB, 100)).toBe(441_500n);
  });
  it('selling 1 000 000 SNEK yields 2 091 631 632 lovelace', () => {
    expect(cpmmAmountOut(1_000_000n, RB, RQ, 100)).toBe(2_091_631_632n);
  });
  it('a dust buy yields zero', () => {
    expect(cpmmAmountOut(1n, RQ, RB, 0)).toBe(0n);
  });
  it('never returns more than the output reserve', () => {
    expect(cpmmAmountOut(10n ** 30n, RQ, RB, 0)).toBeLessThan(RB);
  });
  it('fails closed on bad inputs', () => {
    expect(() => cpmmAmountOut(1n, 0n, RB, 30)).toThrow(/reserve/);
    expect(() => cpmmAmountOut(-1n, RQ, RB, 30)).toThrow(/amount/);
    expect(() => cpmmAmountOut(1n, RQ, RB, 10_000)).toThrow(/fee/);
  });
  it('poolFeeTaken floors', () => {
    expect(poolFeeTaken(1_000_000_000n, 100)).toBe(10_000_000n);
    expect(poolFeeTaken(99n, 100)).toBe(0n);
  });
});
```

`packages/sim-executor/test/simExecutor.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Candle } from '@ctb/engine';
import { costsForPoolId, DEFAULT_COSTS, SimExecutor } from '../src/index.js';

const RQ = 52_331_970_594n;
const RB = 23_779_491n;
const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const MID = '0.002200718703104284'; // priceAdaPerToken(RQ, RB, 0)
const at: Candle = { tickTs: new Date(Date.UTC(2026, 8, 6, 0, 0)), open: MID, high: MID, low: MID, close: MID, volumeQuote: null, poolId: 'SundaeSwapV3:x', poolType: 'cpmm', feeBps: 100,
  closeReserveBase: RB, closeReserveQuote: RQ, tvlLovelace: 2n * RQ };
const next: Candle = { ...at, tickTs: new Date(Date.UTC(2026, 8, 6, 0, 5)) };
const rich = { cashLovelace: 10_000_000_000n, positionBase: 10_000_000n };

describe('SimExecutor cpmm_observed', () => {
  const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' } });

  it('fills a buy at t+1 reserves with pool, batcher, and network fees and 292 bps slippage', () => {
    const r = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, next, rich);
    expect(r).toMatchObject({ status: 'filled', poolId: 'SundaeSwapV3:x', unitIn: 'lovelace', amountIn: 1_000_000_000n, amountOut: 441_500n,
      unitOut: SNEK, poolFeeIn: 10_000_000n, batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n, slippageBps: 292, midPrice: MID, tsFill: next.tickTs });
    expect((r as { fillPrice: string }).fillPrice.startsWith('0.0022650056')).toBe(true);
  });

  it('fills a sell with 496 bps slippage', () => {
    const r = ex.fill({ side: 'sell', amountIn: 1_000_000n, reason: 't' }, at, next, rich);
    expect(r).toMatchObject({ status: 'filled', unitIn: SNEK, unitOut: 'lovelace', amountOut: 2_091_631_632n, slippageBps: 496 });
  });

  it('rejects when t+1 has no reserves, or is not cpmm, or has no pool', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, { ...next, closeReserveBase: null }, rich)).toEqual({ status: 'rejected', reason: 'no reserves at t+1' });
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, { ...next, poolType: 'stable' as 'cpmm' }, rich)).toEqual({ status: 'rejected', reason: 'pool_type stable not cpmm' });
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, { ...next, poolId: null }, rich)).toEqual({ status: 'rejected', reason: 'no pool at t+1' });
  });

  it('rejects insufficient cash (fees included), insufficient position, and dust', () => {
    expect(ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, next, { cashLovelace: 1_001_000_000n, positionBase: 0n })).toEqual({ status: 'rejected', reason: 'insufficient cash' });
    expect(ex.fill({ side: 'sell', amountIn: 5n, reason: 't' }, at, next, { cashLovelace: 0n, positionBase: 4n })).toEqual({ status: 'rejected', reason: 'insufficient position' });
    expect(ex.fill({ side: 'buy', amountIn: 1n, reason: 't' }, at, next, rich)).toEqual({ status: 'rejected', reason: 'dust' });
  });
});

describe('SimExecutor cpmm_synthetic_depth', () => {
  it('builds reserves from price and declared depth and fills with the same math', () => {
    const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: RQ } });
    const ext: Candle = { ...next, poolId: null, poolType: null, feeBps: null, closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null, volumeQuote: '10' };
    const r = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, { ...at, poolId: null }, ext, rich);
    // synthetic reserveBase = RQ / price = 23 779 491 (rounding may differ by 1); fee default 30 bps
    expect(r.status).toBe('filled');
    const f = r as Extract<typeof r, { status: 'filled' }>;
    expect(f.poolId).toBe('synthetic');
    expect(f.poolFeeIn).toBe(3_000_000n);
    expect(f.amountOut).toBeGreaterThan(441_500n); // lower fee than the observed pool
    expect(f.amountOut).toBeLessThan(RB);
  });
});

describe('costsForPoolId', () => {
  it('returns the venue table and applies overrides', () => {
    expect(costsForPoolId('MinswapV2:abc')).toEqual(DEFAULT_COSTS);
    expect(costsForPoolId('Splash:abc', { batcherFeeLovelace: 1_500_000n })).toEqual({ batcherFeeLovelace: 1_500_000n, networkFeeLovelace: 200_000n });
    expect(() => costsForPoolId('FutureSwap:abc')).toThrow(/unknown venue/);
  });
});
```
`baseUnit` is a required executor option because the executor knows the pool, not the token: `unitIn` on sells and `unitOut` on buys are that unit.

- [ ] **Step 3: Run to verify failure**, then implement.

`packages/sim-executor/src/cpmm.ts`:
```ts
/** Constant-product swap output, bigint only. out = in·(10000−fee)·rOut / (rIn·10000 + in·(10000−fee)). */
export function cpmmAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error(`cpmm needs positive reserves, got in=${reserveIn} out=${reserveOut}`);
  if (amountIn < 0n) throw new Error(`cpmm amount must be non-negative, got ${amountIn}`);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) throw new Error(`cpmm fee out of range: ${feeBps} bps`);
  const f = 10_000n - BigInt(feeBps);
  const inWithFee = amountIn * f;
  return (inWithFee * reserveOut) / (reserveIn * 10_000n + inWithFee);
}

export function poolFeeTaken(amountIn: bigint, feeBps: number): bigint {
  return (amountIn * BigInt(feeBps)) / 10_000n;
}
```

`packages/sim-executor/src/costs.ts`:
```ts
import { isDexName, VENUE_NAMES, type DexName } from '@ctb/collector';

/**
 * ASSUMPTION (Plan 2, 2026-09-06): every venue is modelled with a 2 ADA batcher/agent/scooper fee and a
 * 0.2 ADA network fee. Real fees differ per DEX and change; Task 11 checks each venue's published fee and
 * records the values actually used in runs.params. Override per run with --batcher-ada / --network-ada.
 */
export interface VenueCosts { batcherFeeLovelace: bigint; networkFeeLovelace: bigint }

export const DEFAULT_COSTS: VenueCosts = { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n };

export const VENUE_COSTS: Record<DexName, VenueCosts> = Object.fromEntries(VENUE_NAMES.map((v) => [v, DEFAULT_COSTS])) as Record<DexName, VenueCosts>;

export function costsForPoolId(poolId: string, overrides?: Partial<VenueCosts>): VenueCosts {
  const venue = poolId.split(':')[0] ?? '';
  if (!isDexName(venue)) throw new Error(`unknown venue in pool id ${poolId}`);
  return { ...VENUE_COSTS[venue], ...overrides };
}
```

`packages/sim-executor/src/simExecutor.ts`:
```ts
import { formatScaled, PRICE_SCALE, type Decimal } from '@ctb/candles';
import type { Candle, Executor, FillResult, Intent, Portfolio } from '@ctb/engine';
import { costsForPoolId, DEFAULT_COSTS, type VenueCosts } from './costs.js';
import { cpmmAmountOut, poolFeeTaken } from './cpmm.js';

export type FillModel = { kind: 'cpmm_observed' } | { kind: 'cpmm_synthetic_depth'; depthLovelace: bigint };

export interface SimExecutorOptions { decimals: number; baseUnit: string; fillModel: FillModel; costOverrides?: Partial<VenueCosts> }

const SCALE = 10n ** BigInt(PRICE_SCALE);
const SYNTHETIC_FEE_BPS = 30;

function scaledPrice(d: Decimal): bigint {
  const [i, f = ''] = d.split('.');
  return BigInt(i + f.padEnd(PRICE_SCALE, '0').slice(0, PRICE_SCALE));
}

/** ADA per whole token from a lovelace/base amount pair, 18 places. */
function priceFromAmounts(lovelace: bigint, base: bigint, decimals: number): Decimal {
  return formatScaled((lovelace * 10n ** BigInt(decimals) * SCALE) / (base * 1_000_000n));
}

export class SimExecutor implements Executor {
  constructor(private readonly o: SimExecutorOptions) {}

  fill(intent: Intent, at: Candle, next: Candle, portfolio: Readonly<Portfolio>): FillResult {
    const pool = this.resolvePool(next);
    if ('reason' in pool) return { status: 'rejected', reason: pool.reason };
    const costs = pool.poolId === 'synthetic' ? { ...DEFAULT_COSTS, ...this.o.costOverrides } : costsForPoolId(pool.poolId, this.o.costOverrides);
    const lovelaceFees = costs.batcherFeeLovelace + costs.networkFeeLovelace;
    const isBuy = intent.side === 'buy';
    if (isBuy && portfolio.cashLovelace < intent.amountIn + lovelaceFees) return { status: 'rejected', reason: 'insufficient cash' };
    if (!isBuy && portfolio.positionBase < intent.amountIn) return { status: 'rejected', reason: 'insufficient position' };
    const reserveIn = isBuy ? pool.reserveQuote : pool.reserveBase;
    const reserveOut = isBuy ? pool.reserveBase : pool.reserveQuote;
    const amountOut = cpmmAmountOut(intent.amountIn, reserveIn, reserveOut, pool.feeBps);
    if (amountOut <= 0n) return { status: 'rejected', reason: 'dust' };
    if (!isBuy && portfolio.cashLovelace + amountOut < lovelaceFees) return { status: 'rejected', reason: 'insufficient cash' };
    const midRaw = Number(pool.reserveQuote) / Number(pool.reserveBase);
    const fillRaw = isBuy ? Number(intent.amountIn) / Number(amountOut) : Number(amountOut) / Number(intent.amountIn);
    const slippageBps = Math.round((isBuy ? fillRaw / midRaw - 1 : 1 - fillRaw / midRaw) * 10_000);
    const fillPrice = isBuy ? priceFromAmounts(intent.amountIn, amountOut, this.o.decimals) : priceFromAmounts(amountOut, intent.amountIn, this.o.decimals);
    return {
      status: 'filled', poolId: pool.poolId,
      unitIn: isBuy ? 'lovelace' : this.o.baseUnit, amountIn: intent.amountIn,
      unitOut: isBuy ? this.o.baseUnit : 'lovelace', amountOut,
      midPrice: at.close, fillPrice,
      poolFeeIn: poolFeeTaken(intent.amountIn, pool.feeBps),
      batcherFeeLovelace: costs.batcherFeeLovelace, networkFeeLovelace: costs.networkFeeLovelace,
      slippageBps, tsFill: next.tickTs,
    };
  }

  private resolvePool(next: Candle): { poolId: string; reserveBase: bigint; reserveQuote: bigint; feeBps: number } | { reason: string } {
    if (this.o.fillModel.kind === 'cpmm_observed') {
      if (next.poolType !== null && next.poolType !== 'cpmm') return { reason: `pool_type ${String(next.poolType)} not cpmm` };
      if (!next.poolId) return { reason: 'no pool at t+1' };
      if (next.closeReserveBase === null || next.closeReserveQuote === null || next.closeReserveBase <= 0n || next.closeReserveQuote <= 0n || next.feeBps === null) {
        return { reason: 'no reserves at t+1' };
      }
      if (next.poolType !== 'cpmm') return { reason: 'no reserves at t+1' };
      return { poolId: next.poolId, reserveBase: next.closeReserveBase, reserveQuote: next.closeReserveQuote, feeBps: next.feeBps };
    }
    const depth = this.o.fillModel.depthLovelace;
    if (depth <= 0n) return { reason: 'synthetic depth must be positive' };
    const p = scaledPrice(next.close);
    if (p <= 0n) return { reason: 'no price at t+1' };
    const reserveBase = (depth * 10n ** BigInt(this.o.decimals) * SCALE) / (p * 1_000_000n);
    if (reserveBase <= 0n) return { reason: 'synthetic depth too small for price' };
    return { poolId: next.poolId ?? 'synthetic', reserveBase, reserveQuote: depth, feeBps: next.feeBps ?? SYNTHETIC_FEE_BPS };
  }
}
```
Ordering note in `resolvePool` (observed): the `pool_type` check comes first so a `stable` pool with reserves is rejected for the right reason; the second `poolType !== 'cpmm'` line only catches `null` (external candles fed to the observed model), which is a "no reserves" case. Keep both.

`packages/sim-executor/src/index.ts`:
```ts
export { cpmmAmountOut, poolFeeTaken } from './cpmm.js';
export { costsForPoolId, DEFAULT_COSTS, VENUE_COSTS, type VenueCosts } from './costs.js';
export { SimExecutor, type FillModel, type SimExecutorOptions } from './simExecutor.js';
```

- [ ] **Step 4: Tests green, then prove the two spec §7 guards red**

Run: `npx vitest run packages/sim-executor` → 12 passed.
Reinject 1: in `resolvePool`, change the first line to `if (false && …)` so a `stable` pool is accepted → the "not cpmm" assertion FAILS. Restore.
Reinject 2: in `SimExecutor.fill`, use `at` instead of `next` for `resolvePool(at)` (fill at `t`) → the `tsFill`/reserve assertions still pass because the fixtures are equal; so make the fixture distinguishable first: in `simExecutor.test.ts` give `next` different reserves (`closeReserveQuote: RQ + 1_000_000_000n`) and update the expected `amountOut` by computing `cpmmAmountOut` in the test with `next`'s reserves. Then the reinjection FAILS. Restore both. Record both red runs in the commit body.

- [ ] **Step 5: Lint, commit**

```bash
npm run lint && git add -A && git commit -m "feat(sim-executor): constant-product fill at t+1 with pool, batcher, and network costs; observed and synthetic-depth models

Guards proven red: stable pool accepted (reinjected, failed, restored); fill at t instead of t+1 (reinjected, failed, restored).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `@ctb/engine` — run and order provenance in Postgres

**Files:**
- Create: `packages/engine/src/repo.ts`, `packages/engine/test/repo.pg.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces:
  - `interface NewRun { mode: 'backtest' | 'paper'; strategyId: string; params: Record<string, unknown>; gitSha: string; baseUnit: string; dataSource: 'candles' | 'candles_external'; fillModel: 'cpmm_observed' | 'cpmm_synthetic_depth'; dataFrom: Date; dataTo: Date }`
  - `interface RunRow extends NewRun { id: number; createdAt: Date; finishedAt: Date | null; summary: RunSummaryStats | null }`
  - `interface RunRepo { createRun(r: NewRun): Promise<number>; finishRun(id: number, finishedAt: Date, summary: RunSummaryStats): Promise<void>; getRun(id: number): Promise<RunRow | null>; insertOrders(runId: number, baseUnit: string, orders: OrderRecord[]): Promise<number>; listOrders(runId: number): Promise<Array<OrderRecord & { baseUnit: string }>> }`
  - `class PgRunRepo implements RunRepo { constructor(db: Db) }`
  - `gitShaOrUnknown(cwd: string): string` (`git rev-parse HEAD` via `execFileSync`; returns `'unknown'` on any failure and the caller logs a warning)

- [ ] **Step 1: Failing pg test**

`packages/engine/test/repo.pg.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { migrate } from '@ctb/db';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgRunRepo, type OrderRecord } from '../src/index.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';
const t = (m: number) => new Date(Date.UTC(2026, 8, 6, 12, m));

describe.skipIf(!PG_ENABLED)('PgRunRepo', () => {
  it('creates a run, stores filled and rejected orders, finishes with a summary, reads back', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(`INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [SNEK]);
      const repo = new PgRunRepo(db);
      const id = await repo.createRun({ mode: 'backtest', strategyId: 'ma-crossover', params: { fast: 12, slow: 48 }, gitSha: 'abc123', baseUnit: SNEK,
        dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: t(0), dataTo: t(10) });
      const orders: OrderRecord[] = [
        { seq: 1, tsIntent: t(0), intent: { side: 'buy', amountIn: 1_000_000_000n, reason: 'x' }, result: { status: 'filled', poolId: 'SundaeSwapV3:p', unitIn: 'lovelace', amountIn: 1_000_000_000n,
          unitOut: SNEK, amountOut: 441_500n, midPrice: '0.002200718703104284', fillPrice: '0.002265005662514156', poolFeeIn: 10_000_000n, batcherFeeLovelace: 2_000_000n,
          networkFeeLovelace: 200_000n, slippageBps: 292, tsFill: t(5) } },
        { seq: 2, tsIntent: t(5), intent: { side: 'sell', amountIn: 1n, reason: 'y' }, result: { status: 'rejected', reason: 'dust' } },
      ];
      expect(await repo.insertOrders(id, SNEK, orders)).toBe(2);
      await repo.finishRun(id, t(10), { candles: 3, intents: 2, filled: 1, rejected: 1, startEquityLovelace: '1', endEquityLovelace: '2', returnPct: 100, maxDrawdownPct: 0,
        feesLovelace: '2200000', poolFeesIn: '10000000', rejectReasons: { dust: 1 } });
      const run = await repo.getRun(id);
      expect(run).toMatchObject({ id, strategyId: 'ma-crossover', gitSha: 'abc123', dataSource: 'candles', fillModel: 'cpmm_observed', params: { fast: 12, slow: 48 } });
      expect(run?.finishedAt).toEqual(t(10));
      expect(run?.summary?.rejectReasons).toEqual({ dust: 1 });
      const back = await repo.listOrders(id);
      expect(back).toHaveLength(2);
      expect(back[0]?.result).toMatchObject({ status: 'filled', amountOut: 441_500n, slippageBps: 292, tsFill: t(5) });
      expect(back[1]?.result).toEqual({ status: 'rejected', reason: 'dust' });
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement.

`packages/engine/src/repo.ts`:
```ts
import { execFileSync } from 'node:child_process';
import type { Db } from '@ctb/db';
import type { OrderRecord, RunSummaryStats } from './types.js';

export interface NewRun {
  mode: 'backtest' | 'paper'; strategyId: string; params: Record<string, unknown>; gitSha: string; baseUnit: string;
  dataSource: 'candles' | 'candles_external'; fillModel: 'cpmm_observed' | 'cpmm_synthetic_depth'; dataFrom: Date; dataTo: Date;
}
export interface RunRow extends NewRun { id: number; createdAt: Date; finishedAt: Date | null; summary: RunSummaryStats | null }

export interface RunRepo {
  createRun(r: NewRun): Promise<number>;
  finishRun(id: number, finishedAt: Date, summary: RunSummaryStats): Promise<void>;
  getRun(id: number): Promise<RunRow | null>;
  insertOrders(runId: number, baseUnit: string, orders: OrderRecord[]): Promise<number>;
  listOrders(runId: number): Promise<Array<OrderRecord & { baseUnit: string }>>;
}

export function gitShaOrUnknown(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // intentional: a run outside a git checkout is still a run; the caller logs that provenance is missing
    return 'unknown';
  }
}

const ORDER_COLS = 19;

export class PgRunRepo implements RunRepo {
  constructor(private readonly db: Db) {}

  async createRun(r: NewRun): Promise<number> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO runs (mode, strategy_id, params, git_sha, base_unit, data_source, fill_model, data_from, data_to)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [r.mode, r.strategyId, JSON.stringify(r.params), r.gitSha, r.baseUnit, r.dataSource, r.fillModel, r.dataFrom, r.dataTo]);
    const id = res.rows[0]?.id;
    if (id === undefined) throw new Error('createRun returned no id');
    return Number(id);
  }

  async finishRun(id: number, finishedAt: Date, summary: RunSummaryStats): Promise<void> {
    await this.db.query('UPDATE runs SET finished_at = $2, summary = $3::jsonb WHERE id = $1', [id, finishedAt, JSON.stringify(summary)]);
  }

  async getRun(id: number): Promise<RunRow | null> {
    const res = await this.db.query<{
      id: string; mode: 'backtest' | 'paper'; strategy_id: string; params: Record<string, unknown>; git_sha: string; base_unit: string;
      data_source: 'candles' | 'candles_external'; fill_model: 'cpmm_observed' | 'cpmm_synthetic_depth'; data_from: Date; data_to: Date; created_at: Date; finished_at: Date | null; summary: RunSummaryStats | null;
    }>('SELECT * FROM runs WHERE id = $1', [id]);
    const r = res.rows[0];
    if (!r) return null;
    return { id: Number(r.id), mode: r.mode, strategyId: r.strategy_id, params: r.params, gitSha: r.git_sha, baseUnit: r.base_unit, dataSource: r.data_source,
      fillModel: r.fill_model, dataFrom: r.data_from, dataTo: r.data_to, createdAt: r.created_at, finishedAt: r.finished_at, summary: r.summary };
  }

  async insertOrders(runId: number, baseUnit: string, orders: OrderRecord[]): Promise<number> {
    if (orders.length === 0) return 0;
    const values: unknown[] = [];
    const tuples = orders.map((o, i) => {
      const f = o.result.status === 'filled' ? o.result : null;
      values.push(
        runId, o.seq, o.tsIntent, f?.tsFill ?? null, baseUnit, f?.poolId ?? null, o.intent.side,
        f?.unitIn ?? (o.intent.side === 'buy' ? 'lovelace' : baseUnit), o.intent.amountIn.toString(),
        f?.unitOut ?? null, f ? f.amountOut.toString() : null, f?.midPrice ?? null, f?.fillPrice ?? null,
        f ? f.poolFeeIn.toString() : null, f ? f.batcherFeeLovelace.toString() : null, f ? f.networkFeeLovelace.toString() : null,
        f?.slippageBps ?? null, o.result.status, o.result.status === 'rejected' ? o.result.reason : null, o.intent.reason,
      );
      return `(${Array.from({ length: ORDER_COLS + 1 }, (_, k) => `$${i * (ORDER_COLS + 1) + k + 1}`).join(', ')})`;
    });
    const res = await this.db.query(
      `INSERT INTO paper_orders (run_id, seq, ts_intent, ts_fill, base_unit, pool_id, side, unit_in, amount_in, unit_out, amount_out, mid_price, fill_price,
         pool_fee_in, batcher_fee_lovelace, network_fee_lovelace, slippage_bps, status, reject_reason, reason) VALUES ${tuples.join(', ')}`,
      values);
    return res.rowCount ?? 0;
  }

  async listOrders(runId: number): Promise<Array<OrderRecord & { baseUnit: string }>> {
    const res = await this.db.query<{
      seq: number; ts_intent: Date; ts_fill: Date | null; base_unit: string; pool_id: string | null; side: 'buy' | 'sell'; unit_in: string; amount_in: string; unit_out: string | null;
      amount_out: string | null; mid_price: string | null; fill_price: string | null; pool_fee_in: string | null; batcher_fee_lovelace: string | null; network_fee_lovelace: string | null;
      slippage_bps: number | null; status: 'filled' | 'rejected'; reject_reason: string | null; reason: string;
    }>('SELECT * FROM paper_orders WHERE run_id = $1 ORDER BY seq', [runId]);
    return res.rows.map((r) => ({
      seq: r.seq, tsIntent: r.ts_intent, baseUnit: r.base_unit,
      intent: { side: r.side, amountIn: BigInt(r.amount_in), reason: r.reason },
      result: r.status === 'filled'
        ? { status: 'filled', poolId: r.pool_id ?? '', unitIn: r.unit_in, amountIn: BigInt(r.amount_in), unitOut: r.unit_out ?? '', amountOut: BigInt(r.amount_out ?? '0'),
            midPrice: r.mid_price ?? '0', fillPrice: r.fill_price ?? '0', poolFeeIn: BigInt(r.pool_fee_in ?? '0'), batcherFeeLovelace: BigInt(r.batcher_fee_lovelace ?? '0'),
            networkFeeLovelace: BigInt(r.network_fee_lovelace ?? '0'), slippageBps: r.slippage_bps ?? 0, tsFill: r.ts_fill ?? r.ts_intent }
        : { status: 'rejected', reason: r.reject_reason ?? 'unknown' },
    }));
  }
}
```
The column count is 20 (`ORDER_COLS + 1`), matching the 20 columns in the INSERT list; keep the constant honest (rename to `ORDER_PARAMS = 20` if clearer).

Add to `packages/engine/src/index.ts`:
```ts
export { gitShaOrUnknown, PgRunRepo, type NewRun, type RunRepo, type RunRow } from './repo.js';
```

- [ ] **Step 3: pg test green, lint, commit**

```bash
npm run test:pg -- packages/engine && npm run lint
git add -A && git commit -m "feat(engine): run and paper-order provenance repository

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `@ctb/collector` — bounded retry with backoff around Blockfrost calls (spec §4.2; Plan 1 defect)

**Files:**
- Create: `packages/collector/src/retry.ts`, `packages/collector/test/retry.test.ts`
- Modify: `packages/collector/src/dexterSource.ts` (wrap `DefaultPoolFetcher.poolState` and `DexterPoolSource.tip`), `packages/collector/src/index.ts`

**Interfaces:**
- Produces: `retryWithBackoff<T>(fn: () => Promise<T>, opts: { attempts: number; baseMs: number; maxMs: number; budgetMs: number; isTransient: (err: unknown) => boolean; sleep?: (ms: number) => Promise<void>; random?: () => number; onRetry?: (info: { attempt: number; delayMs: number; message: string }) => void }): Promise<T>` — exponential backoff with full jitter, stops when the next delay would exceed the remaining `budgetMs`, rethrows the last error with `after N attempts` appended; non-transient errors are rethrown immediately.
- `isTransientHttpError(err: unknown): boolean` — true for messages/status containing 429, 5xx, `ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND`, `timed out`, `TimeoutError`; false otherwise.

Facts: Dexter's `retries` option is inert for `BlockfrostProvider` (its constructor reads only `timeout`/`proxyUrl`), and Dexter's global `axiosRetry` does not apply to the provider's own axios instance. The tick budget is the interval: `budgetMs = intervalSec * 1000 * 0.5` per call site is passed by the caller (`DexterPoolSource` gets a new option `retryBudgetMs`, default 60_000).

- [ ] **Step 1: Failing tests**

`packages/collector/test/retry.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isTransientHttpError, retryWithBackoff } from '../src/index.js';

const never = async () => {};
describe('retryWithBackoff', () => {
  it('returns on first success without sleeping', async () => {
    const slept: number[] = [];
    const v = await retryWithBackoff(async () => 7, { attempts: 3, baseMs: 100, maxMs: 1000, budgetMs: 10_000, isTransient: () => true, sleep: async (ms) => { slept.push(ms); } });
    expect(v).toBe(7);
    expect(slept).toEqual([]);
  });
  it('retries transient failures with growing jittered delays and succeeds', async () => {
    const slept: number[] = [];
    let n = 0;
    const v = await retryWithBackoff(async () => { if (++n < 3) throw new Error('429 too many'); return 'ok'; },
      { attempts: 5, baseMs: 100, maxMs: 10_000, budgetMs: 60_000, isTransient: isTransientHttpError, sleep: async (ms) => { slept.push(ms); }, random: () => 0.5 });
    expect(v).toBe('ok');
    expect(slept).toEqual([50, 100]); // full jitter with random=0.5: 100*0.5, 200*0.5
  });
  it('rethrows a non-transient error immediately', async () => {
    let n = 0;
    await expect(retryWithBackoff(async () => { n++; throw new Error('404 not found'); }, { attempts: 5, baseMs: 1, maxMs: 1, budgetMs: 1000, isTransient: isTransientHttpError, sleep: never }))
      .rejects.toThrow(/404/);
    expect(n).toBe(1);
  });
  it('gives up after `attempts` and says so', async () => {
    await expect(retryWithBackoff(async () => { throw new Error('503'); }, { attempts: 3, baseMs: 1, maxMs: 1, budgetMs: 1000, isTransient: () => true, sleep: never }))
      .rejects.toThrow(/503.*after 3 attempts/);
  });
  it('stops early when the budget would be exceeded', async () => {
    let n = 0;
    await expect(retryWithBackoff(async () => { n++; throw new Error('503'); }, { attempts: 10, baseMs: 5_000, maxMs: 5_000, budgetMs: 1_000, isTransient: () => true, sleep: never, random: () => 1 }))
      .rejects.toThrow(/budget/);
    expect(n).toBe(1);
  });
});
describe('isTransientHttpError', () => {
  it('classifies', () => {
    expect(isTransientHttpError(new Error('Request failed with status code 429'))).toBe(true);
    expect(isTransientHttpError(new Error('blockfrost /blocks/latest returned 502'))).toBe(true);
    expect(isTransientHttpError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientHttpError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientHttpError(new Error('Request failed with status code 403'))).toBe(false);
    expect(isTransientHttpError('Unable to determine DEX')).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

`packages/collector/src/retry.ts`:
```ts
export interface RetryOptions {
  attempts: number; baseMs: number; maxMs: number; budgetMs: number;
  isTransient: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; message: string }) => void;
}

const TRANSIENT = /\b(429|5\d\d)\b|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|timed out|TimeoutError/;

export function isTransientHttpError(err: unknown): boolean {
  if (err instanceof Error) return TRANSIENT.test(err.message) || TRANSIENT.test(err.name);
  return false;
}

/** Exponential backoff with full jitter, bounded by attempts AND a wall-clock budget. Non-transient errors escape at once. */
export async function retryWithBackoff<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  let spent = 0;
  let last: unknown;
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!o.isTransient(err)) throw err;
      if (attempt === o.attempts) break;
      const cap = Math.min(o.maxMs, o.baseMs * 2 ** (attempt - 1));
      const delay = Math.floor(cap * random());
      if (spent + cap > o.budgetMs) {
        throw new Error(`${(err as Error).message ?? String(err)} (retry budget ${o.budgetMs} ms exhausted after ${attempt} attempts)`);
      }
      o.onRetry?.({ attempt, delayMs: delay, message: (err as Error).message ?? String(err) });
      await sleep(delay);
      spent += delay;
    }
  }
  throw new Error(`${(last as Error)?.message ?? String(last)} (after ${o.attempts} attempts)`);
}
```
Note: the budget test uses `random: () => 1`, so the first computed `cap` (5000) exceeds the 1000 ms budget before any sleep, which is the required early stop.

In `dexterSource.ts`: add `retryBudgetMs?: number` to `DexterPoolSourceOptions` (default 60_000); wrap `poolState` in `DefaultPoolFetcher` and the fetch inside `tip()` with `retryWithBackoff(…, { attempts: 4, baseMs: 500, maxMs: 8_000, budgetMs, isTransient: isTransientHttpError, onRetry: (i) => log.warn(i, 'blockfrost retry') })`. `discover` is not wrapped (Dexter swallows its errors anyway; a failed venue is already counted). Export both functions from `index.ts`.

- [ ] **Step 3: Tests, existing suite, lint, commit**

```bash
npx vitest run packages/collector && npm test && npm run lint
git add -A && git commit -m "fix(collector): bounded retry with jittered backoff around Blockfrost tip and pool-state calls (spec §4.2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: CLI — `backtest` and `report`

**Files:**
- Create: `packages/cli/src/commands/backtest.ts`, `packages/cli/src/commands/report.ts`, `packages/cli/src/feeds.ts`, `packages/cli/test/backtestArgs.test.ts`
- Modify: `packages/cli/src/main.ts`, `packages/cli/package.json` (add `@ctb/engine`, `@ctb/sim-executor`), `package.json` (scripts `backtest`, `report`)

**Interfaces:**
- Produces:
  - `parseBacktestArgs(args: string[]): { strategyId: string; ticker: string; from: Date; to: Date; source: 'candles' | 'candles_external'; cashAda: number; depthAda: number | null; batcherAda: number | null; networkAda: number | null; params: Record<string, number> }` — positional `<strategy> <TICKER> <from> <to>`, flags `--source candles|external` (default `candles`), `--cash-ada N` (default 1000), `--depth-ada N` (required when source is external; forbidden otherwise), `--batcher-ada N`, `--network-ada N`, `--param key=value` (repeatable, numeric). Throws with a usage line on any error.
  - `localCandleFeed(repo: CandleRepo, unit: string, from: Date, to: Date): AsyncIterable<Candle>` and `externalCandleFeed(repo: ExternalRepo, unit: string, from: Date, to: Date): AsyncIterable<Candle>` — map rows to the engine `Candle` shape (external: reserve fields null, `volumeQuote` set, `poolId`/`poolType`/`feeBps` null).
  - CLI `backtest …` creates the `runs` row first and prints its id, runs the engine, stores orders, finishes the run, then prints the report. CLI `report <run-id>` prints the same report for a stored run.

- [ ] **Step 1: Failing arg-parser tests**

`packages/cli/test/backtestArgs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseBacktestArgs } from '../src/commands/backtest.js';

describe('parseBacktestArgs', () => {
  it('parses positionals, defaults, and params', () => {
    const a = parseBacktestArgs(['ma-crossover', 'SNEK', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '--param', 'fast=6', '--param', 'slow=24']);
    expect(a).toMatchObject({ strategyId: 'ma-crossover', ticker: 'SNEK', source: 'candles', cashAda: 1000, depthAda: null, params: { fast: 6, slow: 24 } });
    expect(a.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
  it('requires --depth-ada for the external source and forbids it otherwise', () => {
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--source', 'external'])).toThrow(/--depth-ada is required/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--depth-ada', '5000'])).toThrow(/--depth-ada only applies/);
    expect(parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--source', 'external', '--depth-ada', '5000']).depthAda).toBe(5000);
  });
  it('rejects bad dates, empty windows, non-numeric params, unknown flags', () => {
    expect(() => parseBacktestArgs(['s', 'T', 'soon', '2026-09-01'])).toThrow(/from/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-09-01', '2026-08-01'])).toThrow(/before/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--param', 'fast=quick'])).toThrow(/numeric/);
    expect(() => parseBacktestArgs(['s', 'T', '2026-08-01', '2026-09-01', '--bogus'])).toThrow(/unknown flag --bogus/);
  });
});
```

- [ ] **Step 2: Implement**

`packages/cli/src/feeds.ts`:
```ts
import type { CandleRepo, ExternalRepo } from '@ctb/candles';
import type { Candle } from '@ctb/engine';

export async function* localCandleFeed(repo: CandleRepo, unit: string, from: Date, to: Date): AsyncIterable<Candle> {
  for (const r of await repo.readCandles(unit, from, to)) {
    yield { tickTs: r.tickTs, open: r.open, high: r.high, low: r.low, close: r.close, volumeQuote: null, poolId: r.poolId, poolType: r.poolType, feeBps: r.feeBps,
      closeReserveBase: r.closeReserveBase, closeReserveQuote: r.closeReserveQuote, tvlLovelace: r.tvlLovelace };
  }
}

export async function* externalCandleFeed(repo: ExternalRepo, unit: string, from: Date, to: Date): AsyncIterable<Candle> {
  for (const r of await repo.readExternal(unit, from, to)) {
    yield { tickTs: r.tickTs, open: r.open, high: r.high, low: r.low, close: r.close, volumeQuote: r.volumeQuote, poolId: null, poolType: null, feeBps: null,
      closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null };
  }
}
```

`packages/cli/src/commands/backtest.ts`:
```ts
import { PgCandleRepo, PgExternalRepo } from '@ctb/candles';
import { createPool } from '@ctb/db';
import { gitShaOrUnknown, PgRunRepo, runEngine, STRATEGIES } from '@ctb/engine';
import { SimExecutor, type FillModel } from '@ctb/sim-executor';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { externalCandleFeed, localCandleFeed } from '../feeds.js';
import { printReport } from './report.js';
import { parseIsoDate } from './backfill.js';

export interface BacktestArgs {
  strategyId: string; ticker: string; from: Date; to: Date; source: 'candles' | 'candles_external';
  cashAda: number; depthAda: number | null; batcherAda: number | null; networkAda: number | null; params: Record<string, number>;
}

const USAGE = 'usage: backtest <strategy> <TICKER> <from-ISO> <to-ISO> [--source candles|external] [--cash-ada N] [--depth-ada N] [--batcher-ada N] [--network-ada N] [--param k=v]...';

function num(flag: string, v: string | undefined): number {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative number, got ${v ?? '(missing)'}\n${USAGE}`);
  return n;
}

export function parseBacktestArgs(args: string[]): BacktestArgs {
  const [strategyId, ticker, fromArg, toArg, ...rest] = args;
  if (!strategyId || !ticker) throw new Error(USAGE);
  const from = parseIsoDate('from', fromArg);
  const to = parseIsoDate('to', toArg);
  if (from.getTime() >= to.getTime()) throw new Error(`from must be before to\n${USAGE}`);
  const out: BacktestArgs = { strategyId, ticker, from, to, source: 'candles', cashAda: 1000, depthAda: null, batcherAda: null, networkAda: null, params: {} };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const val = rest[i + 1];
    switch (flag) {
      case '--source':
        if (val !== 'candles' && val !== 'external') throw new Error(`--source must be candles or external\n${USAGE}`);
        out.source = val === 'external' ? 'candles_external' : 'candles'; i++; break;
      case '--cash-ada': out.cashAda = num(flag, val); i++; break;
      case '--depth-ada': out.depthAda = num(flag, val); i++; break;
      case '--batcher-ada': out.batcherAda = num(flag, val); i++; break;
      case '--network-ada': out.networkAda = num(flag, val); i++; break;
      case '--param': {
        const [k, v] = (val ?? '').split('=');
        const n = Number(v);
        if (!k || v === undefined || !Number.isFinite(n)) throw new Error(`--param needs key=numeric value, got ${val ?? '(missing)'}\n${USAGE}`);
        out.params[k] = n; i++; break;
      }
      default: throw new Error(`unknown flag ${flag}\n${USAGE}`);
    }
  }
  if (out.source === 'candles_external' && out.depthAda === null) throw new Error(`--depth-ada is required with --source external (declared pool depth in ADA for the synthetic fill model)\n${USAGE}`);
  if (out.source === 'candles' && out.depthAda !== null) throw new Error(`--depth-ada only applies to --source external; observed reserves are used otherwise\n${USAGE}`);
  return out;
}

const ada = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

export async function backtestCommand(log: Logger, args: string[]): Promise<void> {
  const a = parseBacktestArgs(args);
  const strategy = STRATEGIES[a.strategyId];
  if (!strategy) throw new Error(`unknown strategy ${a.strategyId}; known: ${Object.keys(STRATEGIES).join(', ')}`);
  const cfg = loadConfig(process.env, { blockfrost: false });
  const universe = await loadUniverse();
  const token = universe.tokens.find((t) => t.ticker === a.ticker);
  if (!token) throw new Error(`unknown ticker ${a.ticker}; not in universe.json`);
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const runs = new PgRunRepo(db);
    const gitSha = gitShaOrUnknown(process.cwd());
    if (gitSha === 'unknown') log.warn({}, 'git sha unknown: run provenance is incomplete');
    const fillModel: FillModel = a.source === 'candles' ? { kind: 'cpmm_observed' } : { kind: 'cpmm_synthetic_depth', depthLovelace: ada(a.depthAda ?? 0) };
    const costOverrides = { ...(a.batcherAda !== null ? { batcherFeeLovelace: ada(a.batcherAda) } : {}), ...(a.networkAda !== null ? { networkFeeLovelace: ada(a.networkAda) } : {}) };
    const params = { ...strategy.defaultParams, ...a.params };
    const runId = await runs.createRun({
      mode: 'backtest', strategyId: strategy.id, gitSha, baseUnit: token.unit, dataSource: a.source, fillModel: fillModel.kind, dataFrom: a.from, dataTo: a.to,
      params: { ...params, cashAda: a.cashAda, depthAda: a.depthAda, costs: { batcherFeeLovelace: (costOverrides.batcherFeeLovelace ?? 2_000_000n).toString(), networkFeeLovelace: (costOverrides.networkFeeLovelace ?? 200_000n).toString() } },
    });
    console.log(`run id: ${runId}`);
    const feed = a.source === 'candles' ? localCandleFeed(new PgCandleRepo(db), token.unit, a.from, a.to) : externalCandleFeed(new PgExternalRepo(db), token.unit, a.from, a.to);
    const executor = new SimExecutor({ decimals: token.decimals, baseUnit: token.unit, fillModel, costOverrides });
    const result = await runEngine({ feed, strategy, params: a.params, executor, initial: { cashLovelace: ada(a.cashAda), positionBase: 0n }, decimals: token.decimals, log });
    await runs.insertOrders(runId, token.unit, result.orders);
    await runs.finishRun(runId, new Date(), result.summary);
    const run = await runs.getRun(runId);
    if (!run) throw new Error(`run ${runId} vanished`);
    printReport(run, await runs.listOrders(runId), token.ticker);
  } finally {
    await db.end();
  }
}
```

`packages/cli/src/commands/report.ts`:
```ts
import { createPool } from '@ctb/db';
import { PgRunRepo, type OrderRecord, type RunRow } from '@ctb/engine';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

const adaStr = (lovelace: string | bigint): string => (Number(BigInt(lovelace)) / 1_000_000).toFixed(6);

/** Operator output. Every number here comes from the runs row and its orders; the header is the provenance. */
export function printReport(run: RunRow, orders: Array<OrderRecord & { baseUnit: string }>, ticker: string): void {
  console.log(`\n=== run ${run.id} | ${run.mode} | ${run.strategyId} | ${ticker} | git ${run.gitSha}`);
  console.log(`data: ${run.dataSource} ${run.dataFrom.toISOString()} -> ${run.dataTo.toISOString()} | fill model: ${run.fillModel}`);
  console.log(`params: ${JSON.stringify(run.params)}`);
  if (!run.summary) { console.log('run has no summary (unfinished)'); return; }
  const s = run.summary;
  console.table([{ candles: s.candles, intents: s.intents, filled: s.filled, rejected: s.rejected, startAda: adaStr(s.startEquityLovelace), endAda: adaStr(s.endEquityLovelace),
    returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct, lovelaceFeesAda: adaStr(s.feesLovelace), poolFeesIn: s.poolFeesIn }]);
  if (Object.keys(s.rejectReasons).length) console.table(Object.entries(s.rejectReasons).map(([reason, count]) => ({ reason, count })));
  console.table(orders.slice(0, 50).map((o) => ({
    seq: o.seq, intent: o.tsIntent.toISOString(), side: o.intent.side, amountIn: o.intent.amountIn.toString(), status: o.result.status,
    fill: o.result.status === 'filled' ? o.result.tsFill.toISOString() : '-', amountOut: o.result.status === 'filled' ? o.result.amountOut.toString() : '-',
    slippageBps: o.result.status === 'filled' ? o.result.slippageBps : '-', reason: o.result.status === 'rejected' ? o.result.reason : o.intent.reason,
  })));
  if (orders.length > 50) console.log(`... ${orders.length - 50} more orders (query paper_orders where run_id = ${run.id})`);
}

export async function reportCommand(log: Logger, args: string[]): Promise<void> {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id <= 0) throw new Error('usage: report <run-id>');
  const cfg = loadConfig(process.env, { blockfrost: false });
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const runs = new PgRunRepo(db);
    const run = await runs.getRun(id);
    if (!run) throw new Error(`no run ${id}`);
    const universe = await loadUniverse();
    const ticker = universe.tokens.find((t) => t.unit === run.baseUnit)?.ticker ?? run.baseUnit;
    printReport(run, await runs.listOrders(id), ticker);
  } finally {
    await db.end();
  }
}
```
Wire `case 'backtest': return backtestCommand(log, rest);` and `case 'report': return reportCommand(log, rest);` in `main.ts`; extend usage; add the two root scripts; add `@ctb/engine` and `@ctb/sim-executor` to `packages/cli/package.json`; `npm install`.

- [ ] **Step 3: Unit tests, lint, then a real backtest on external history (network for backfill only; no key)**

```bash
npx vitest run packages/cli && npm test && npm run lint
npm run migrate
npm run backfill -- SNEK 2026-06-01T00:00:00Z 2026-09-01T00:00:00Z
npm run backtest -- ma-crossover SNEK 2026-06-01T00:00:00Z 2026-09-01T00:00:00Z --source external --depth-ada 800000
npm run backtest -- ma-crossover SNEK 2026-06-01T00:00:00Z 2026-09-01T00:00:00Z --source external --depth-ada 800000
```
Expected: two run ids; both reports identical except the run id and timestamps (determinism across processes). Verify:
```bash
docker exec -it ctb_postgres psql -U ctb -d ctb -c "SELECT run_id, count(*), sum(amount_out) FROM paper_orders WHERE run_id IN (SELECT id FROM runs ORDER BY id DESC LIMIT 2) GROUP BY run_id;"
```
Both rows must show the same count and sum. `--depth-ada 800000` mirrors the Minswap v2 SNEK/ADA pool's observed ~837 k USD reserve (≈ 0.5 M ADA per side); it is an operator declaration and is recorded in `runs.params`.

- [ ] **Step 4: Commit, PR `feat/m2-engine` → main (Tasks 5-10), CI green, merge**

```bash
git add -A && git commit -m "feat(cli): backtest and report commands with run provenance

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: M2 acceptance — a backtest report on real data, costs verified, written record

**Files:**
- Create: `docs/ops/2026-09-XX-m2-report.md` (XX = the day it is written)

**Interfaces:** none; this is the evidence M3 (paper mode) builds on.

- [ ] **Step 1: Verify the per-venue cost assumption against each DEX's published fee**

For each venue in `VENUE_COSTS` (Minswap, MinswapV2, SundaeSwapV1, SundaeSwapV3, MuesliSwap, WingRiders, WingRidersV2, VyFinance, Splash) read the venue's own docs page for its batcher/agent/scooper fee as of the date you read it, and record `venue, fee in ADA, source URL, date read` in the report. Where a venue's fee differs from 2 ADA, open a follow-up PR that changes that entry in `packages/sim-executor/src/costs.ts` and adjusts the `costsForPoolId` test. Do not guess a value you could not read.

- [ ] **Step 2: Run the two acceptance backtests and the determinism check**

```bash
npm run backfill -- SNEK 2026-06-01T00:00:00Z 2026-09-01T00:00:00Z
npm run backtest -- ma-crossover SNEK 2026-06-01T00:00:00Z 2026-09-01T00:00:00Z --source external --depth-ada 800000
npm run backtest -- ma-crossover SNEK 2026-06-01T00:00:00Z 2026-09-01T00:00:00Z --source external --depth-ada 800000
```
Then, if the collector has been running (Task 9 of Plan 1) for at least three days:
```bash
npm run candles
npm run backtest -- ma-crossover SNEK <first candle ISO> <last candle ISO> --source candles --param fast=6 --param slow=24
```
Record every run id, the git sha the report header shows, and paste the report tables verbatim.

- [ ] **Step 3: Acceptance queries**

```sql
-- Provenance: every run finished, with a sha and a fill model
SELECT id, strategy_id, git_sha, data_source, fill_model, finished_at IS NOT NULL AS finished FROM runs ORDER BY id;
-- Determinism: the two external runs match exactly
SELECT run_id, count(*) AS orders, sum(amount_out) AS out_total, sum(slippage_bps) AS slip_total FROM paper_orders GROUP BY run_id ORDER BY run_id;
-- External coverage per universe token (which tokens still have no history)
SELECT t.ticker, m.match_method, c.first, c.last, c.rows FROM tokens t LEFT JOIN external_pool_map m ON m.base_unit = t.unit
LEFT JOIN LATERAL (SELECT min(tick_ts) first, max(tick_ts) last, count(*) rows FROM candles_external e WHERE e.base_unit = t.unit) c ON true ORDER BY t.ticker;
-- Local candles: the no-volume rule and the pool-change rule hold
SELECT count(*) FILTER (WHERE net_flow_base IS NULL) AS pool_changes_or_first, count(*) AS candles FROM candles;
```

- [ ] **Step 4: Write the report**

`docs/ops/2026-09-XX-m2-report.md` must contain: the cost table from Step 1; the three query outputs verbatim; the run ids and sha; one paragraph stating plainly that the external-history backtest used a **declared** depth (synthetic fill model) and what that means for the numbers; the list of universe tokens with no external history; the reference strategy's result with the sentence "this is a plumbing check, not a strategy result". End with "M2 met" or "M2 not met because …".

- [ ] **Step 5: Commit the report on its own branch and open the PR**

```bash
git checkout main && git pull --ff-only && git checkout -b docs/m2-report
git add docs/ops && git commit -m "docs(ops): M2 acceptance report

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## PR grouping (each off `main`, never stacked; wait for the previous merge before branching the next)

| PR | Branch | Tasks |
| --- | --- | --- |
| M2 part 1 | `feat/m2-schema` | 1, 2, 3 |
| M2 part 2 | `feat/m2-backfill` | 4 |
| M2 part 3 | `feat/m2-engine` | 5, 6, 7, 8, 9, 10 |
| M2 report | `docs/m2-report` | 11 |

If part 3 grows past comfortable review size, split at Task 8: `feat/m2-engine` (5-8) and `feat/m2-executor-cli` (9-10).

## Open items the founder decides (do not block Tasks 1-10)

1. **Per-venue costs.** The 2 ADA / 0.2 ADA table is a labeled assumption; Task 11 replaces it with read values. Until then every report prints the values used.
2. **Synthetic depth policy.** Backtests on external history need `--depth-ada`. The plan proposes using the GeckoTerminal `reserve_in_usd` of the matched pool converted at the ADA price of the day as the default suggestion in the report; whether to automate that (it adds a price-feed dependency) is your call for Plan 3.
3. **Blockfrost key and M1.** Local candles, and therefore the `cpmm_observed` backtest, exist only after the collector has run. Nothing in Tasks 1-10 depends on it; Task 11's local-candle backtest does.

## Deviations from the spec, recorded

- Spec §4.3 describes local candles as OHLCV from snapshots. With one observation per 5-minute tick the four price columns are identical; the columns are kept for shape compatibility with external candles and the report says so. Finer OHLC needs sub-tick sampling, which the free tier does not afford (Plan 1 Facts).
- Spec §4.5 fills against observed reserves. For history that predates the collector, this plan adds the `cpmm_synthetic_depth` model with an operator-declared depth, recorded in `runs.fill_model` and `runs.params`. It is the same math with a labeled input, not a flat-slippage shortcut.
- Spec §4.2's retry (a Plan 1 gap) is closed here in Task 9, not in the collector plan.

## Plan self-review (done at writing time)

- Spec coverage: §4.3 candles = Tasks 2-3 (build, net flows, no volume) and Task 4 (external table, never merged); §4.4 engine = Tasks 5-6 (Strategy interface, one loop, injected clock via the feed, indicators, reference strategy); §4.5 sim-executor = Task 7 (t+1, cpmm, costs, fail closed on non-cpmm and missing t+1) with provenance in Task 8; §4.6 cli = Tasks 3, 4, 10 (`candles`, `backfill`, `backtest`, `report`; `paper` is Plan 3); §5 tables = Task 1 (`candles`, `candles_external`, `runs`, `paper_orders`, plus `external_pool_map` not in the spec, added for the match method); §6 fail closed = Tasks 2, 4, 7, 10; §7 tests = cpmm hand cases (T7), candle fixture with net-zero window (T2), determinism (T6 in-process, T10 across processes), guards for no-volume column (T1) and stable-pool rejection (T7), both with reinjection steps; §8 M2 = Task 11.
- Placeholder scan: no TBD/TODO; every code step carries the code; the only "XX" is the report filename date by construction.
- Type consistency: `Decimal`, `CandleRow`, `SnapshotForCandle`, `GeckoCandle`, `Candle`, `Intent`, `Portfolio`, `FillResult`, `Executor`, `OrderRecord`, `RunSummaryStats`, `NewRun`, `RunRow`, `VenueCosts`, `FillModel` are each defined once (Tasks 2, 4, 6, 7, 8) and consumed under the same names in Tasks 3, 6, 7, 8, 10. `paper_orders` has 20 columns; `PgRunRepo.insertOrders` pushes 20 values per row. `candles` has 14 columns; `PgCandleRepo.insertCandles` pushes 14.
