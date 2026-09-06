# Paper-Trading Foundation, Plan 1 of 2 (M0 + M1: repo, database, universe, collector)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A collector that, every 5 minutes, records the live reserves of every ADA pool for 20 Cardano tokens across nine DEX venues into Postgres, with a per-tick liveness row, so that Plan 2 can build candles and a backtester on top of trustworthy data.

**Architecture:** npm-workspaces monorepo, TypeScript run from source with `tsx` (no build step). Four packages: `@ctb/db` (pool + SQL migrations), `@ctb/universe` (committed token list, validated fail-closed), `@ctb/collector` (pure mapping + Postgres repo + Dexter/Blockfrost source + tick runner), `@ctb/cli` (`migrate`, `collect`, `status`). Pool discovery is expensive and runs once a day; per-tick refresh is one Blockfrost call per pool.

**Tech Stack:** Node 24, TypeScript 5 strict, `tsx`, Vitest, ESLint flat config, `pg`, `zod`, `pino`, `@indigo-labs/dexter` 5.4.10 (MIT, ESM), Blockfrost mainnet API, Postgres 16 in Docker Compose.

**Spec:** `docs/specs/2026-09-05-paper-trading-foundation.md`

**Why the plan is split:** Spec open question 1 (Blockfrost free-tier budget) and the probe results below decide the candle interval and whether GeckoTerminal backfill is needed per pair. Plan 2 (candles, engine, sim-executor, backtest, paper) is written after M1 has measured real calls per tick.

## Facts verified on 2026-09-05 (do not re-derive)

- `@indigo-labs/dexter` 5.4.10 is ESM with extensionless internal imports. Plain `node` fails with `ERR_MODULE_NOT_FOUND`; `tsx` loads it; an esbuild bundle does not run (lucid-cardano WASM). **Runtime is `tsx` everywhere.**
- Dexter venue names: `Minswap`, `MinswapV2`, `SundaeSwapV1`, `SundaeSwapV3`, `MuesliSwap`, `WingRiders`, `WingRidersV2`, `VyFinance`, `Splash`.
- Dexter's public-API path is not usable as primary source: `MinswapV2` and `WingRidersV2` have no API adapter (`dex.api` undefined, throws), and `Minswap`, `MuesliSwap`, `WingRiders`, `VyFinance` returned zero SNEK/ADA pools. **Pool state comes on-chain via Dexter's `BlockfrostProvider`.**
- `FetchRequest.getLiquidityPools()` with a data provider = full discovery: paginated scan of every pool of every venue (expensive, run daily). `FetchRequest.getLiquidityPoolState(pool)` = one `/addresses/{addr}/utxos/{asset}` call per pool (cheap, run per tick). Dexter's `BlockfrostProvider` has a built-in Bottleneck limiter.
- `LiquidityPool` fields used: `dex`, `identifier`, `address`, `assetA`, `assetB` (`'lovelace' | Asset{policyId,nameHex,decimals}`), `reserveA`, `reserveB` (bigint), `poolFeePercent` (number, e.g. `1` = 1%). No pool-type field exists; Minswap v2 pools are discovered by the CPMM validity NFT, so stable pools never appear. Pool type is therefore asserted per venue by our own table and enforced by a DB CHECK.
- Live SundaeSwapV3 SNEK/ADA pool captured for fixtures: `identifier` starts `cacb7fd5f5b84bf8`, `reserveA` (lovelace) `52331970594`, `reserveB` (SNEK) `23779491`, `poolFeePercent` `1`.
  - **Correction 2026-09-06:** that pool came from Dexter's DEX-API path, which is stale relative to the chain; on-chain discovery through Blockfrost finds no SNEK/ADA pool on SundaeSwapV3 (its only SNEK pool is NIGHT/SNEK). The numbers above remain valid as arithmetic fixtures; the live test uses NIGHT/ADA on SundaeSwapV3 instead and asserts SNEK there yields one counted venue failure.
- **First real collector tick, measured 2026-09-06 against mainnet Blockfrost:** Minswap v1 discovery took 16 min; Minswap v2 took 5.5 min (~3,300 provider calls); SundaeSwapV3 took ~9 s (~550 calls). Splash never finished — `Splash.liquidityPools(provider)` (Dexter's own on-chain discovery) calls `provider.utxos(address)` **unfiltered** for each of its 11 fixed pool addresses, then `datumValue` for every UTxO returned; Splash hosts thousands of tiny pools, so this is unbounded and the tick ran 50+ minutes without completing. Separately, `VyFinance.liquidityPools()` in Dexter is a hardcoded `Promise.reject('Not implemented as VyFinance pools are not easily identifiable on-chain.')` — it fails every tick regardless of runtime, not from a transient error. **Fix:** Blockfrost's `/addresses/{address}/utxos/{asset}` filters UTxOs by asset, and every Dexter DEX class exposes `liquidityPoolFromUtxo(provider, utxo)` publicly, so Splash is now discovered per address × requested token (`dex.liquidityPoolAddresses(provider)` × `provider.utxos(address, asset)` × `dex.liquidityPoolFromUtxo(provider, utxo)`) instead of scanning every UTxO at those addresses — `DefaultPoolFetcher.discoverBounded` in `packages/collector/src/dexterSource.ts`. VyFinance is excluded from the default `COLLECT_VENUES` list (`venues.ts`'s `discovery: 'unsupported'`) rather than failing every tick; it can still be requested explicitly. **Caveat found while wiring this up, not yet independently confirmed against a live Splash pool:** the installed `@indigo-labs/dexter@5.4.10`'s `Splash.liquidityPoolFromUtxo` (`build/dex/splash.js`) builds and populates the `LiquidityPool` object on a successful parse but its function body falls through to an unconditional `return undefined;` after the `try` block on every path — it never returns the object it just built. If that holds on mainnet, the bounded path fixes the unbounded-call problem but Splash will still report zero pools every tick (a `discover:Splash` "returned no pools" RunError, same failure shape as VyFinance) until Dexter's bug is patched or Splash gets its own `liquidityPoolFromUtxo` here. Verify with a live Splash pool before relying on this venue.
- **Caveat above confirmed, 2026-09-06 — Splash is unsupported, not merely bounded:** the fall-through in `Splash.liquidityPoolFromUtxo` is unconditional on every code path (the success path after building `liquidityPool`, and the catch block), so it holds regardless of runtime input; `venues.ts` now marks Splash `discovery: 'unsupported'` (same as VyFinance) rather than `'per-token-address'`, and `DEFAULT_VENUES`/`COLLECT_VENUES`'s default excludes both. The bounded per-address/token strategy and `discoverBounded` code path are kept, gated behind `DefaultPoolFetcherOptions.discoveryOverride`, as the one-line re-enable once Dexter is fixed or upgraded. **First real collector tick end to end (run 50, mainnet):** 66 min, 39,781 Blockfrost calls, 102 pools across the 7 supported venues — Minswap 14, MinswapV2 20, SundaeSwapV1 22, SundaeSwapV3 9, MuesliSwap 12, WingRiders 11, WingRidersV2 14; Splash and VyFinance were each one counted venue failure, and Splash alone consumed roughly 24k of the 39,781 calls for zero pools. `DexterPoolSource.discover` now tracks Blockfrost calls per venue (`lastDiscoveryCalls()`) and `runTick` records them on `collector_runs.discovery_calls` (migration `0005_discovery_calls.sql`) so a repeat of this cost is visible per-venue in `status` without re-deriving it from logs.
- Universe seed (konnektr `/api/getMarketTokens` page 1, sorted by market cap desc, fetched once 2026-09-05): 20 tokens listed verbatim in Task 3. `policy_name` there is `policyId(56 hex) || assetNameHex`.

## Global Constraints

- Node `>=24` (`.nvmrc` = `24`). ESM only (`"type": "module"`). TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `@typescript-eslint/no-explicit-any: error`.
- No build step. Everything runs via `tsx`; tests via `vitest`.
- Amounts are `bigint` in code and `numeric(38,0)` in Postgres, in the asset's smallest unit. Never `number` for amounts.
- Parameterized SQL only. `pool_type` column has `CHECK (pool_type IN ('cpmm'))`.
- No `console.log` outside `packages/cli`; packages receive a `Logger`. No empty `catch` blocks; every skip is a counted row or a logged line with a reason.
- Secrets: only `BLOCKFROST_PROJECT_ID`, read from `.env` (gitignored). Compose Postgres password is local-only and non-secret.
- Postgres in Compose listens on host port `5433` (the czi stack owns `5432`).
- Tests that need Postgres are guarded by `RUN_PG_TESTS=1`; tests that hit Blockfrost by `RUN_LIVE_TESTS=1`. Both are skipped (not failing) otherwise.
- Every task ends with a commit on a branch off `main`; nothing is committed to `main` directly.
- Every new guard test is proven red once by reinjecting the defect before it is trusted (steps say where).

---

### Task 1: Workspace scaffold and toolchain smoke test

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.nvmrc`, `.env.example`, `docker-compose.yml`, `README.md`, `test/toolchain.test.ts`
- Modify: `.gitignore` (add `pgdata/`)

**Interfaces:**
- Produces: workspace convention `packages/<name>/package.json` with `"name": "@ctb/<name>"`, `"exports": "./src/index.ts"`; test location `packages/<name>/test/*.test.ts`; scripts `npm test`, `npm run test:pg`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 1: Create the branch**

```bash
cd ~/code/cardano-trading-bots && git checkout main && git checkout -b feat/m0-scaffold
```

- [ ] **Step 2: Write the failing smoke test**

`test/toolchain.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs on Node 24 or newer', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(24);
  });
});
```

- [ ] **Step 3: Run it to verify it fails (no vitest yet)**

Run: `npx vitest run`
Expected: fails with "vitest: command not found" or similar, because nothing is installed.

- [ ] **Step 4: Write the root config files**

`package.json`:
```json
{
  "name": "cardano-trading-bots",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "test:pg": "RUN_PG_TESTS=1 vitest run",
    "test:live": "RUN_LIVE_TESTS=1 vitest run packages/collector/test/dexterSource.live.test.ts",
    "typecheck": "tsc -p tsconfig.json",
    "lint": "eslint . && npm run typecheck",
    "migrate": "tsx packages/cli/src/main.ts migrate",
    "collect": "tsx packages/cli/src/main.ts collect",
    "status": "tsx packages/cli/src/main.ts status"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "eslint": "^9.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": { "@ctb/*": ["packages/*/src/index.ts"] }
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

`eslint.config.js`:
```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'pgdata/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
```

`.nvmrc`:
```
24
```

`.env.example`:
```
# Local Postgres from docker-compose.yml (host port 5433; password is local-only, not a secret)
DATABASE_URL=postgres://ctb:ctb_local_only@localhost:5433/ctb
# Blockfrost mainnet project id (https://blockfrost.io). Required by `collect`, not by `migrate`/`status`.
BLOCKFROST_PROJECT_ID=
# Seconds between collector ticks. 300 = 5-minute candles later.
COLLECT_INTERVAL_SECONDS=300
LOG_LEVEL=info
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    container_name: ctb_postgres
    environment:
      POSTGRES_USER: ctb
      POSTGRES_PASSWORD: ctb_local_only
      POSTGRES_DB: ctb
    ports:
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ctb -d ctb"]
      interval: 5s
      timeout: 3s
      retries: 20
volumes:
  pgdata: {}
```

`README.md`:
```markdown
# cardano-trading-bots

Paper-trading foundation for Cardano DEX bots. No real funds move in this repo.
Design: `docs/specs/2026-09-05-paper-trading-foundation.md`. Plan: `docs/plans/`.

## Quick start

    nvm use && npm install
    cp .env.example .env            # add BLOCKFROST_PROJECT_ID
    docker compose up -d postgres
    npm run migrate
    npm run collect -- --once
    npm run status

## Checks

    npm test        # unit tests
    npm run test:pg # needs docker compose postgres
    npm run lint
```

Append to `.gitignore`:
```
pgdata/
```

- [ ] **Step 5: Install and run the smoke test**

Run: `npm install && npm test`
Expected: 1 test passed.

- [ ] **Step 6: Lint and typecheck**

Run: `npm run lint`
Expected: no errors. If `typescript-eslint` complains about the `.js` config file being untyped, add `{ files: ['*.js'], ...tseslint.configs.disableTypeChecked }` is NOT needed with `recommended` (non-type-checked); leave as is.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: workspace scaffold, toolchain smoke test, compose postgres

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `@ctb/db` — pool factory, migration runner, core schema

**Files:**
- Create: `packages/db/package.json`, `packages/db/src/index.ts`, `packages/db/src/pool.ts`, `packages/db/src/migrate.ts`, `packages/db/migrations/0001_core.sql`, `packages/db/test/migrate.test.ts`, `packages/db/test/migrate.pg.test.ts`, `packages/db/test/helpers.ts`

**Interfaces:**
- Produces:
  - `createPool(databaseUrl: string, onError: (err: Error) => void): pg.Pool`
  - `listMigrations(dir?: string): Promise<string[]>` (sorted filenames, throws on duplicate 4-digit prefix)
  - `migrate(db: pg.Pool, dir?: string): Promise<string[]>` (returns filenames applied this run)
  - `MIGRATIONS_DIR: string`
  - Test helper `withTestSchema(fn: (db: pg.Pool) => Promise<void>): Promise<void>` (fresh schema per test, dropped after)
  - Tables `tokens`, `collector_runs`, `pool_snapshots` as defined in Step 4.

- [ ] **Step 1: Package manifest**

`packages/db/package.json`:
```json
{
  "name": "@ctb/db",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": { "pg": "^8.13.0" },
  "devDependencies": { "@types/pg": "^8.11.0" }
}
```
Run: `npm install`

- [ ] **Step 2: Write the failing unit test for migration listing**

`packages/db/test/migrate.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listMigrations } from '../src/migrate.js';

async function dirWith(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctb-mig-'));
  for (const f of files) await writeFile(path.join(dir, f), '-- test');
  return dir;
}

describe('listMigrations', () => {
  it('returns matching files sorted by number', async () => {
    const dir = await dirWith(['0002_b.sql', '0001_a.sql', 'README.md', '0003_c.sql.bak']);
    expect(await listMigrations(dir)).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('fails closed on a duplicate number', async () => {
    const dir = await dirWith(['0001_a.sql', '0001_b.sql']);
    await expect(listMigrations(dir)).rejects.toThrow(/duplicate migration number 0001/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/db`
Expected: FAIL, cannot resolve `../src/migrate.js`.

- [ ] **Step 4: Implement pool, migrate, and the SQL**

`packages/db/src/pool.ts`:
```ts
import pg from 'pg';

export type Db = pg.Pool;

/** One pool per process. `onError` receives idle-client errors so they never crash the process silently. */
export function createPool(databaseUrl: string, onError: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  pool.on('error', onError);
  return pool;
}
```

`packages/db/src/migrate.ts`:
```ts
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Sorted migration filenames. Throws if two files share a number: silent shadowing is how schemas drift. */
export async function listMigrations(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const seen = new Map<string, string>();
  for (const f of files) {
    const num = MIGRATION_FILE.exec(f)?.[1] ?? '';
    const prior = seen.get(num);
    if (prior !== undefined) throw new Error(`duplicate migration number ${num}: ${prior} and ${f}`);
    seen.set(num, f);
  }
  return files;
}

/** Applies unapplied migrations in order, each in its own transaction. Returns what it applied. */
export async function migrate(db: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const appliedRows = await db.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.rows.map((r) => r.filename));
  const ran: string[] = [];
  for (const file of await listMigrations(dir)) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}
```

`packages/db/src/index.ts`:
```ts
export { createPool, type Db } from './pool.js';
export { listMigrations, migrate, MIGRATIONS_DIR } from './migrate.js';
```

`packages/db/migrations/0001_core.sql`:
```sql
-- Universe mirror. `unit` = policy_id || asset_name_hex, the Cardano asset identifier.
CREATE TABLE IF NOT EXISTS tokens (
  unit            text PRIMARY KEY,
  policy_id       text NOT NULL CHECK (length(policy_id) = 56),
  asset_name_hex  text NOT NULL,
  ticker          text NOT NULL,
  decimals        smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  category        text NOT NULL,
  seeded_at       date NOT NULL,
  seed_source     text NOT NULL,
  CHECK (unit = policy_id || asset_name_hex)
);

-- One row per collector tick. This is the liveness signal: a gap here is visible in one query.
CREATE TABLE IF NOT EXISTS collector_runs (
  id              bigserial PRIMARY KEY,
  tick_ts         timestamptz NOT NULL,          -- interval bucket the tick belongs to
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz,
  pools_attempted int NOT NULL DEFAULT 0,
  pools_failed    int NOT NULL DEFAULT 0,
  pools_written   int NOT NULL DEFAULT 0,
  provider_calls  int NOT NULL DEFAULT 0,        -- Blockfrost calls made by this tick
  discovered      boolean NOT NULL DEFAULT false, -- true when this tick ran full pool discovery
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS collector_runs_tick_ts ON collector_runs (tick_ts DESC);

-- One row per pool per tick. Reserves are smallest units. Only constant-product pools are accepted;
-- widening pool_type is a deliberate migration, never a silent write.
CREATE TABLE IF NOT EXISTS pool_snapshots (
  run_id          bigint NOT NULL REFERENCES collector_runs(id),
  tick_ts         timestamptz NOT NULL,
  dex             text NOT NULL,
  pool_id         text NOT NULL,                 -- dex || ':' || dexter identifier
  pool_address    text NOT NULL,
  base_unit       text NOT NULL REFERENCES tokens(unit),
  quote_unit      text NOT NULL DEFAULT 'lovelace' CHECK (quote_unit = 'lovelace'),
  reserve_base    numeric(38,0) NOT NULL CHECK (reserve_base >= 0),
  reserve_quote   numeric(38,0) NOT NULL CHECK (reserve_quote >= 0),
  fee_bps         int NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  pool_type       text NOT NULL CHECK (pool_type IN ('cpmm')),
  tvl_lovelace    numeric(38,0) NOT NULL CHECK (tvl_lovelace >= 0),
  block_height    bigint NOT NULL,
  observed_at     timestamptz NOT NULL,
  PRIMARY KEY (pool_id, tick_ts)
);
CREATE INDEX IF NOT EXISTS pool_snapshots_base_tick ON pool_snapshots (base_unit, tick_ts);
```

- [ ] **Step 5: Run the unit test**

Run: `npx vitest run packages/db/test/migrate.test.ts`
Expected: 2 passed.

- [ ] **Step 6: Write the Postgres test helper and the guarded pg test**

`packages/db/test/helpers.ts`:
```ts
import { randomBytes } from 'node:crypto';
import pg from 'pg';

export const PG_ENABLED = process.env.RUN_PG_TESTS === '1';

/** Runs `fn` against a fresh schema on the compose database, then drops it. Migrations use unqualified names, so search_path isolates them. */
export async function withTestSchema(fn: (db: pg.Pool) => Promise<void>): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgres://ctb:ctb_local_only@localhost:5433/ctb';
  const schema = `t_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
  try {
    await fn(db);
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
```

`packages/db/test/migrate.pg.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { PG_ENABLED, withTestSchema } from './helpers.js';

describe.skipIf(!PG_ENABLED)('migrate (postgres)', () => {
  it('applies 0001_core once and is idempotent', async () => {
    await withTestSchema(async (db) => {
      const first = await migrate(db);
      expect(first).toEqual(['0001_core.sql']);
      const second = await migrate(db);
      expect(second).toEqual([]);
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1`,
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual([
        'collector_runs',
        'pool_snapshots',
        'schema_migrations',
        'tokens',
      ]);
    });
  });

  it('rejects a non-cpmm pool_type at the database', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      await db.query(
        `INSERT INTO tokens VALUES ('279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b',
          '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`,
      );
      const run = await db.query<{ id: string }>(
        `INSERT INTO collector_runs (tick_ts, started_at) VALUES (now(), now()) RETURNING id`,
      );
      await expect(
        db.query(
          `INSERT INTO pool_snapshots (run_id, tick_ts, dex, pool_id, pool_address, base_unit, reserve_base, reserve_quote,
             fee_bps, pool_type, tvl_lovelace, block_height, observed_at)
           VALUES ($1, now(), 'MinswapV2', 'MinswapV2:x', 'addr1x', '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b',
             1, 1, 30, 'stable', 2, 1, now())`,
          [run.rows[0]?.id],
        ),
      ).rejects.toThrow(/pool_snapshots_pool_type_check/);
    });
  });
});
```

- [ ] **Step 7: Run the pg tests against compose**

Run: `docker compose up -d postgres && npm run test:pg -- packages/db`
Expected: 4 passed (2 unit + 2 pg).

- [ ] **Step 8: Prove the CHECK guard is real**

Temporarily edit `0001_core.sql` to `CHECK (pool_type IN ('cpmm','stable'))`, run `npm run test:pg -- packages/db`, expect the second pg test to FAIL. Restore the file, rerun, expect PASS. Mention the red run in the commit body.

- [ ] **Step 9: Lint, commit**

Run: `npm run lint`
```bash
git add -A && git commit -m "feat(db): pool factory, migration runner, core schema

pool_type CHECK proven red with a widened IN list, then restored.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `@ctb/universe` — committed token list, validated fail-closed

**Files:**
- Create: `packages/universe/package.json`, `packages/universe/universe.json`, `packages/universe/src/index.ts`, `packages/universe/src/schema.ts`, `packages/universe/src/load.ts`, `packages/universe/test/load.test.ts`

**Interfaces:**
- Produces:
  - `interface TokenSpec { ticker: string; policyId: string; assetNameHex: string; decimals: number; category: string; unit: string }`
  - `interface Pair { base: TokenSpec; quote: 'lovelace' }`
  - `interface Universe { seededAt: string; seedSource: string; tokens: TokenSpec[]; pairs: Pair[] }`
  - `loadUniverse(file?: string): Promise<Universe>` (throws naming the offending entry; rejects duplicate units and tickers)
  - `parseUniverse(raw: unknown): Universe` (pure; used by tests)

- [ ] **Step 1: Package manifest**

`packages/universe/package.json`:
```json
{
  "name": "@ctb/universe",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": { "zod": "^3.23.0" }
}
```
Run: `npm install`

- [ ] **Step 2: Write the failing tests**

`packages/universe/test/load.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadUniverse, parseUniverse } from '../src/index.js';

const valid = {
  seededAt: '2026-09-05',
  seedSource: 'test',
  tokens: [
    { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme' },
    { ticker: 'MIN', policyId: '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6', assetNameHex: '4d494e', decimals: 6, category: 'Dex' },
  ],
};

describe('parseUniverse', () => {
  it('derives unit and ADA pairs', () => {
    const u = parseUniverse(valid);
    expect(u.tokens[0]?.unit).toBe('279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b');
    expect(u.pairs).toHaveLength(2);
    expect(u.pairs[1]?.quote).toBe('lovelace');
    expect(u.pairs[1]?.base.ticker).toBe('MIN');
  });

  it('fails closed on a bad policy id and names the entry', () => {
    const bad = structuredClone(valid);
    bad.tokens[1]!.policyId = 'not-hex';
    expect(() => parseUniverse(bad)).toThrow(/tokens\[1\]\.policyId.*MIN/);
  });

  it('rejects an empty asset name paired with a duplicate unit', () => {
    const bad = structuredClone(valid);
    bad.tokens[1] = { ...bad.tokens[0]!, ticker: 'SNEK2' };
    expect(() => parseUniverse(bad)).toThrow(/duplicate unit/);
  });

  it('rejects duplicate tickers', () => {
    const bad = structuredClone(valid);
    bad.tokens[1] = { ...bad.tokens[1]!, ticker: 'SNEK' };
    expect(() => parseUniverse(bad)).toThrow(/duplicate ticker SNEK/);
  });

  it('rejects decimals outside 0..18', () => {
    const bad = structuredClone(valid);
    bad.tokens[0]!.decimals = 19;
    expect(() => parseUniverse(bad)).toThrow(/decimals/);
  });
});

describe('loadUniverse (committed file)', () => {
  it('loads exactly 20 tokens with unique units', async () => {
    const u = await loadUniverse();
    expect(u.tokens).toHaveLength(20);
    expect(new Set(u.tokens.map((t) => t.unit)).size).toBe(20);
    expect(u.pairs.every((p) => p.quote === 'lovelace')).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/universe`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement schema, loader, and the committed universe**

`packages/universe/src/schema.ts`:
```ts
import { z } from 'zod';

export const tokenEntrySchema = z.object({
  ticker: z.string().regex(/^[A-Za-z0-9]{1,12}$/, 'ticker must be 1-12 alphanumerics'),
  policyId: z.string().regex(/^[0-9a-f]{56}$/, 'policyId must be 56 lowercase hex chars'),
  assetNameHex: z.string().regex(/^(?:[0-9a-f]{2}){0,32}$/, 'assetNameHex must be 0-32 lowercase hex bytes'),
  decimals: z.number().int().min(0).max(18),
  category: z.string().min(1),
});

export const universeFileSchema = z.object({
  seededAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seedSource: z.string().min(1),
  tokens: z.array(tokenEntrySchema).min(1),
});

export type TokenEntry = z.infer<typeof tokenEntrySchema>;
```

`packages/universe/src/load.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { universeFileSchema } from './schema.js';

export interface TokenSpec {
  ticker: string;
  policyId: string;
  assetNameHex: string;
  decimals: number;
  category: string;
  /** policyId || assetNameHex: the Cardano asset identifier used by Blockfrost and Dexter. */
  unit: string;
}

export interface Pair {
  base: TokenSpec;
  quote: 'lovelace';
}

export interface Universe {
  seededAt: string;
  seedSource: string;
  tokens: TokenSpec[];
  pairs: Pair[];
}

export const UNIVERSE_FILE = fileURLToPath(new URL('../universe.json', import.meta.url));

/** Pure validation. Every failure names the entry so a bad row is fixed, never skipped. */
export function parseUniverse(raw: unknown): Universe {
  const parsed = universeFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const idx = issue?.path[1];
    const ticker =
      typeof idx === 'number' && typeof raw === 'object' && raw !== null
        ? (raw as { tokens?: Array<{ ticker?: unknown }> }).tokens?.[idx]?.ticker
        : undefined;
    const where = issue ? issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('').replace(/^\./, '') : '?';
    throw new Error(`universe invalid at ${where}${ticker ? ` (${String(ticker)})` : ''}: ${issue?.message ?? 'unknown'}`);
  }
  const tokens: TokenSpec[] = parsed.data.tokens.map((t) => ({ ...t, unit: t.policyId + t.assetNameHex }));
  const units = new Set<string>();
  const tickers = new Set<string>();
  for (const t of tokens) {
    if (units.has(t.unit)) throw new Error(`universe invalid: duplicate unit ${t.unit} (${t.ticker})`);
    if (tickers.has(t.ticker)) throw new Error(`universe invalid: duplicate ticker ${t.ticker}`);
    units.add(t.unit);
    tickers.add(t.ticker);
  }
  return {
    seededAt: parsed.data.seededAt,
    seedSource: parsed.data.seedSource,
    tokens,
    pairs: tokens.map((base) => ({ base, quote: 'lovelace' as const })),
  };
}

export async function loadUniverse(file: string = UNIVERSE_FILE): Promise<Universe> {
  const text = await readFile(file, 'utf8');
  return parseUniverse(JSON.parse(text));
}
```

`packages/universe/src/index.ts`:
```ts
export { loadUniverse, parseUniverse, UNIVERSE_FILE, type Pair, type TokenSpec, type Universe } from './load.js';
```

`packages/universe/universe.json` (verbatim seed; `assetNameHex` is everything after the 56-char policy id):
```json
{
  "seededAt": "2026-09-05",
  "seedSource": "konnektr.net /api/getMarketTokens?currency=ada&page=1, top 20 by marketcap, fetched once by hand",
  "tokens": [
    { "ticker": "NIGHT",  "policyId": "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa", "assetNameHex": "4e49474854", "decimals": 6, "category": "Privacy" },
    { "ticker": "USDCx",  "policyId": "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34", "assetNameHex": "5553444378", "decimals": 6, "category": "Stable" },
    { "ticker": "SNEK",   "policyId": "279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f", "assetNameHex": "534e454b", "decimals": 0, "category": "Meme" },
    { "ticker": "WMTX",   "policyId": "e5a42a1a1d3d1da71b0449663c32798725888d2eb0843c4dabeca05a", "assetNameHex": "576f726c644d6f62696c65546f6b656e58", "decimals": 6, "category": "DePin" },
    { "ticker": "STRIKE", "policyId": "f13ac4d66b3ee19a6aa0f2a22298737bd907cc95121662fc971b5275", "assetNameHex": "535452494b45", "decimals": 6, "category": "Perpetuals" },
    { "ticker": "AGIX",   "policyId": "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc535", "assetNameHex": "41474958", "decimals": 8, "category": "AI" },
    { "ticker": "USDM",   "policyId": "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad", "assetNameHex": "0014df105553444d", "decimals": 6, "category": "Stable" },
    { "ticker": "IAG",    "policyId": "5d16cc1a177b5d9ba9cfa9793b07e60f1fb70fea1f8aef064415d114", "assetNameHex": "494147", "decimals": 6, "category": "Storage" },
    { "ticker": "HOSKY",  "policyId": "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235", "assetNameHex": "484f534b59", "decimals": 0, "category": "Meme" },
    { "ticker": "MIN",    "policyId": "29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6", "assetNameHex": "4d494e", "decimals": 6, "category": "Dex" },
    { "ticker": "SONG",   "policyId": "f71b4cf652d8edb33a57928b8b8a546a3c954b7ba24db5583ac79b34", "assetNameHex": "534f4e474d41524b4554434150", "decimals": 0, "category": "Music" },
    { "ticker": "LQ",     "policyId": "da8c30857834c6ae7203935b89278c532b3995245295456f993e1d24", "assetNameHex": "4c51", "decimals": 6, "category": "DeFi" },
    { "ticker": "USDA",   "policyId": "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456", "assetNameHex": "55534441", "decimals": 6, "category": "Stable" },
    { "ticker": "ASCEND", "policyId": "eb7a93ebc321647673490810f618b548d7c24aa64d30ae342dba7076", "assetNameHex": "0014df10415343454e44", "decimals": 6, "category": "Perpetuals" },
    { "ticker": "NVL",    "policyId": "5b26e685cc5c9ad630bde3e3cd48c694436671f3d25df53777ca60ef", "assetNameHex": "4e564c", "decimals": 6, "category": "DePin" },
    { "ticker": "STUFF",  "policyId": "51a5e236c4de3af2b8020442e2a26f454fda3b04cb621c1294a0ef34", "assetNameHex": "424f4f4b", "decimals": 6, "category": "Books" },
    { "ticker": "SHEN",   "policyId": "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61", "assetNameHex": "5368656e4d6963726f555344", "decimals": 6, "category": "Reserve" },
    { "ticker": "INDY",   "policyId": "533bb94a8850ee3ccbe483106489399112b74c905342cb1792a797a0", "assetNameHex": "494e4459", "decimals": 6, "category": "Synthetics" },
    { "ticker": "FLDT",   "policyId": "577f0b1342f8f8f4aed3388b80a8535812950c7a892495c0ecdf0f1e", "assetNameHex": "0014df10464c4454", "decimals": 6, "category": "Lending" },
    { "ticker": "COPI",   "policyId": "b6a7467ea1deb012808ef4e87b5ff371e85f7142d7b356a40d9b42a0", "assetNameHex": "436f726e75636f70696173205b76696120436861696e506f72742e696f5d", "decimals": 6, "category": "Gaming" }
  ]
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/universe`
Expected: 6 passed. If the "names the entry" test fails on the regex, print the thrown message and adjust only the test's regex to the actual wording, keeping index, ticker, and field in it.

- [ ] **Step 6: Lint, commit**

```bash
npm run lint && git add -A && git commit -m "feat(universe): committed top-20 token list with fail-closed validation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `@ctb/collector` — venue table and pure pool-to-snapshot mapping

**Files:**
- Create: `packages/collector/package.json`, `packages/collector/src/index.ts`, `packages/collector/src/types.ts`, `packages/collector/src/venues.ts`, `packages/collector/src/snapshot.ts`, `packages/collector/test/snapshot.test.ts`

**Interfaces:**
- Produces:
  - `type DexName = 'Minswap'|'MinswapV2'|'SundaeSwapV1'|'SundaeSwapV3'|'MuesliSwap'|'WingRiders'|'WingRidersV2'|'VyFinance'|'Splash'`
  - `const VENUES: Record<DexName, { poolType: 'cpmm' }>`; `const VENUE_NAMES: DexName[]`
  - `type PoolAsset = 'lovelace' | { policyId: string; nameHex: string }`
  - `interface PoolLike { dex: string; identifier: string; address: string; assetA: PoolAsset; assetB: PoolAsset; reserveA: bigint; reserveB: bigint; poolFeePercent: number }`
  - `interface SnapshotRow { tickTs: Date; dex: DexName; poolId: string; poolAddress: string; baseUnit: string; quoteUnit: 'lovelace'; reserveBase: bigint; reserveQuote: bigint; feeBps: number; poolType: 'cpmm'; tvlLovelace: bigint; blockHeight: number; observedAt: Date }`
  - `interface Logger { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; error(obj: object, msg: string): void }`
  - `poolToSnapshot(pool: PoolLike, ctx: { tickTs: Date; blockHeight: number; observedAt: Date }): SnapshotRow` (throws on unknown dex, non-ADA pair, or fee outside 0..100%)
  - `bucketTick(at: Date, intervalSec: number): Date` (floors to the interval boundary)
  - `poolIdOf(pool: Pick<PoolLike, 'dex' | 'identifier'>): string` (`dex + ':' + identifier`)

- [ ] **Step 1: Package manifest**

`packages/collector/package.json`:
```json
{
  "name": "@ctb/collector",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@ctb/db": "*",
    "@ctb/universe": "*",
    "@indigo-labs/dexter": "5.4.10",
    "pg": "^8.13.0"
  },
  "devDependencies": { "@types/pg": "^8.11.0" }
}
```
Run: `npm install`

- [ ] **Step 2: Write the failing tests**

`packages/collector/test/snapshot.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { bucketTick, poolIdOf, poolToSnapshot, type PoolLike } from '../src/index.js';

const SNEK = { policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', nameHex: '534e454b' };
const ctx = { tickTs: new Date('2026-09-05T15:00:00Z'), blockHeight: 12_345_678, observedAt: new Date('2026-09-05T15:00:07Z') };

// Live SundaeSwapV3 SNEK/ADA pool captured 2026-09-05.
const sundaeV3: PoolLike = {
  dex: 'SundaeSwapV3',
  identifier: 'cacb7fd5f5b84bf8',
  address: 'addr1_sundae_pool',
  assetA: 'lovelace',
  assetB: SNEK,
  reserveA: 52_331_970_594n,
  reserveB: 23_779_491n,
  poolFeePercent: 1,
};

describe('poolToSnapshot', () => {
  it('orients ADA as quote and the token as base', () => {
    const row = poolToSnapshot(sundaeV3, ctx);
    expect(row.poolId).toBe('SundaeSwapV3:cacb7fd5f5b84bf8');
    expect(row.baseUnit).toBe(SNEK.policyId + SNEK.nameHex);
    expect(row.quoteUnit).toBe('lovelace');
    expect(row.reserveBase).toBe(23_779_491n);
    expect(row.reserveQuote).toBe(52_331_970_594n);
    expect(row.feeBps).toBe(100);
    expect(row.poolType).toBe('cpmm');
    expect(row.tvlLovelace).toBe(2n * 52_331_970_594n);
    expect(row.blockHeight).toBe(12_345_678);
    expect(row.tickTs).toEqual(ctx.tickTs);
  });

  it('handles the flipped orientation (token as assetA)', () => {
    const flipped: PoolLike = { ...sundaeV3, assetA: SNEK, assetB: 'lovelace', reserveA: 23_779_491n, reserveB: 52_331_970_594n };
    const row = poolToSnapshot(flipped, ctx);
    expect(row.reserveBase).toBe(23_779_491n);
    expect(row.reserveQuote).toBe(52_331_970_594n);
  });

  it('rounds fractional fee percent to basis points', () => {
    expect(poolToSnapshot({ ...sundaeV3, poolFeePercent: 0.3 }, ctx).feeBps).toBe(30);
    expect(poolToSnapshot({ ...sundaeV3, poolFeePercent: 0.05 }, ctx).feeBps).toBe(5);
  });

  it('fails closed on an unknown venue', () => {
    expect(() => poolToSnapshot({ ...sundaeV3, dex: 'FutureSwap' }, ctx)).toThrow(/unknown venue FutureSwap/);
  });

  it('fails closed on a pool with no ADA side', () => {
    const usdm = { policyId: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad', nameHex: '0014df105553444d' };
    expect(() => poolToSnapshot({ ...sundaeV3, assetA: usdm }, ctx)).toThrow(/not an ADA pair/);
  });

  it('fails closed on an impossible fee', () => {
    expect(() => poolToSnapshot({ ...sundaeV3, poolFeePercent: 150 }, ctx)).toThrow(/fee/);
    expect(() => poolToSnapshot({ ...sundaeV3, poolFeePercent: -1 }, ctx)).toThrow(/fee/);
  });
});

describe('bucketTick', () => {
  it('floors to the interval boundary', () => {
    expect(bucketTick(new Date('2026-09-05T15:07:41Z'), 300)).toEqual(new Date('2026-09-05T15:05:00Z'));
    expect(bucketTick(new Date('2026-09-05T15:05:00Z'), 300)).toEqual(new Date('2026-09-05T15:05:00Z'));
  });
});

describe('poolIdOf', () => {
  it('joins dex and identifier', () => {
    expect(poolIdOf({ dex: 'MinswapV2', identifier: 'abc' })).toBe('MinswapV2:abc');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/collector`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement types, venues, snapshot**

`packages/collector/src/types.ts`:
```ts
import type { DexName } from './venues.js';

export type PoolAsset = 'lovelace' | { policyId: string; nameHex: string };

/** The subset of Dexter's LiquidityPool the collector reads. Structural so tests never import Dexter. */
export interface PoolLike {
  dex: string;
  identifier: string;
  address: string;
  assetA: PoolAsset;
  assetB: PoolAsset;
  reserveA: bigint;
  reserveB: bigint;
  /** Percent, as Dexter reports it: 1 means 1%. */
  poolFeePercent: number;
}

export interface SnapshotRow {
  tickTs: Date;
  dex: DexName;
  poolId: string;
  poolAddress: string;
  baseUnit: string;
  quoteUnit: 'lovelace';
  reserveBase: bigint;
  reserveQuote: bigint;
  feeBps: number;
  poolType: 'cpmm';
  /** 2 x ADA reserve: the usual AMM approximation. Used only to pick the deepest pool. */
  tvlLovelace: bigint;
  blockHeight: number;
  observedAt: Date;
}

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
```

`packages/collector/src/venues.ts`:
```ts
/** Every venue Dexter 5.4.10 knows. Pool type is asserted here because Dexter exposes none;
 *  Minswap v2 / Splash stable pools are discovered by different validity assets and never reach us. */
export const VENUES = {
  Minswap: { poolType: 'cpmm' },
  MinswapV2: { poolType: 'cpmm' },
  SundaeSwapV1: { poolType: 'cpmm' },
  SundaeSwapV3: { poolType: 'cpmm' },
  MuesliSwap: { poolType: 'cpmm' },
  WingRiders: { poolType: 'cpmm' },
  WingRidersV2: { poolType: 'cpmm' },
  VyFinance: { poolType: 'cpmm' },
  Splash: { poolType: 'cpmm' },
} as const satisfies Record<string, { poolType: 'cpmm' }>;

export type DexName = keyof typeof VENUES;
export const VENUE_NAMES = Object.keys(VENUES) as DexName[];

export function isDexName(name: string): name is DexName {
  return Object.prototype.hasOwnProperty.call(VENUES, name);
}
```

`packages/collector/src/snapshot.ts`:
```ts
import type { PoolAsset, PoolLike, SnapshotRow } from './types.js';
import { VENUES, isDexName } from './venues.js';

export function poolIdOf(pool: Pick<PoolLike, 'dex' | 'identifier'>): string {
  return `${pool.dex}:${pool.identifier}`;
}

export function bucketTick(at: Date, intervalSec: number): Date {
  const ms = intervalSec * 1000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

function unitOf(asset: Exclude<PoolAsset, 'lovelace'>): string {
  return asset.policyId + asset.nameHex;
}

/** Pure. Throws instead of guessing: an unknown venue, a non-ADA pair, or a nonsense fee is a bug upstream. */
export function poolToSnapshot(
  pool: PoolLike,
  ctx: { tickTs: Date; blockHeight: number; observedAt: Date },
): SnapshotRow {
  if (!isDexName(pool.dex)) throw new Error(`unknown venue ${pool.dex} for pool ${pool.identifier}`);
  const aIsAda = pool.assetA === 'lovelace';
  const bIsAda = pool.assetB === 'lovelace';
  if (aIsAda === bIsAda) throw new Error(`not an ADA pair: ${poolIdOf(pool)}`);
  const base = (aIsAda ? pool.assetB : pool.assetA) as Exclude<PoolAsset, 'lovelace'>;
  const reserveBase = aIsAda ? pool.reserveB : pool.reserveA;
  const reserveQuote = aIsAda ? pool.reserveA : pool.reserveB;
  if (!Number.isFinite(pool.poolFeePercent) || pool.poolFeePercent < 0 || pool.poolFeePercent > 100) {
    throw new Error(`fee out of range for ${poolIdOf(pool)}: ${pool.poolFeePercent}`);
  }
  return {
    tickTs: ctx.tickTs,
    dex: pool.dex,
    poolId: poolIdOf(pool),
    poolAddress: pool.address,
    baseUnit: unitOf(base),
    quoteUnit: 'lovelace',
    reserveBase,
    reserveQuote,
    feeBps: Math.round(pool.poolFeePercent * 100),
    poolType: VENUES[pool.dex].poolType,
    tvlLovelace: 2n * reserveQuote,
    blockHeight: ctx.blockHeight,
    observedAt: ctx.observedAt,
  };
}
```

`packages/collector/src/index.ts`:
```ts
export type { Logger, PoolAsset, PoolLike, SnapshotRow } from './types.js';
export { VENUES, VENUE_NAMES, isDexName, type DexName } from './venues.js';
export { bucketTick, poolIdOf, poolToSnapshot } from './snapshot.js';
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/collector`
Expected: 9 passed.

- [ ] **Step 6: Lint, commit**

```bash
npm run lint && git add -A && git commit -m "feat(collector): venue table and pure pool-to-snapshot mapping

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `@ctb/collector` — Postgres repository

**Files:**
- Create: `packages/collector/src/repo.ts`, `packages/collector/test/repo.pg.test.ts`
- Modify: `packages/collector/src/index.ts`

**Interfaces:**
- Consumes: `Db` from `@ctb/db`; `TokenSpec` from `@ctb/universe`; `SnapshotRow` from Task 4; `withTestSchema`, `PG_ENABLED` from `packages/db/test/helpers.ts`; `migrate` from `@ctb/db`.
- Produces:
  - `interface RunSummary { poolsAttempted: number; poolsFailed: number; poolsWritten: number; providerCalls: number; discovered: boolean; errors: Array<{ scope: string; message: string }> }`
  - `interface RunRow { id: number; tickTs: Date; startedAt: Date; finishedAt: Date | null; poolsAttempted: number; poolsFailed: number; poolsWritten: number; providerCalls: number; discovered: boolean; errors: Array<{ scope: string; message: string }> }`
  - `interface SnapshotRepo { syncTokens(tokens: TokenSpec[], seed: { seededAt: string; seedSource: string }): Promise<void>; startRun(tickTs: Date, startedAt: Date): Promise<number>; insertSnapshots(runId: number, rows: SnapshotRow[]): Promise<number>; finishRun(runId: number, finishedAt: Date, summary: RunSummary): Promise<void>; lastRuns(limit: number): Promise<RunRow[]> }`
  - `class PgSnapshotRepo implements SnapshotRepo { constructor(db: Db) }`

- [ ] **Step 1: Write the failing pg test**

`packages/collector/test/repo.pg.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { migrate } from '@ctb/db';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';
import { PgSnapshotRepo, type SnapshotRow } from '../src/index.js';

const snek = {
  ticker: 'SNEK',
  policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f',
  assetNameHex: '534e454b',
  decimals: 0,
  category: 'Meme',
  unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b',
};

function row(poolId: string, tickTs: Date): SnapshotRow {
  return {
    tickTs,
    dex: 'SundaeSwapV3',
    poolId,
    poolAddress: 'addr1_x',
    baseUnit: snek.unit,
    quoteUnit: 'lovelace',
    reserveBase: 23_779_491n,
    reserveQuote: 52_331_970_594n,
    feeBps: 100,
    poolType: 'cpmm',
    tvlLovelace: 104_663_941_188n,
    blockHeight: 1,
    observedAt: tickTs,
  };
}

describe.skipIf(!PG_ENABLED)('PgSnapshotRepo', () => {
  it('records a run, its snapshots, and reads it back', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      await repo.syncTokens([snek], { seededAt: '2026-09-05', seedSource: 'test' });
      await repo.syncTokens([snek], { seededAt: '2026-09-05', seedSource: 'test' }); // idempotent
      const tick = new Date('2026-09-05T15:05:00Z');
      const runId = await repo.startRun(tick, new Date('2026-09-05T15:05:01Z'));
      const written = await repo.insertSnapshots(runId, [row('SundaeSwapV3:a', tick), row('SundaeSwapV3:b', tick)]);
      expect(written).toBe(2);
      const again = await repo.insertSnapshots(runId, [row('SundaeSwapV3:a', tick)]);
      expect(again).toBe(0); // same pool, same tick: idempotent
      await repo.finishRun(runId, new Date('2026-09-05T15:05:09Z'), {
        poolsAttempted: 2, poolsFailed: 0, poolsWritten: 2, providerCalls: 3, discovered: true, errors: [],
      });
      const runs = await repo.lastRuns(5);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: runId, poolsWritten: 2, providerCalls: 3, discovered: true });
      expect(runs[0]?.finishedAt).toEqual(new Date('2026-09-05T15:05:09Z'));
      const stored = await db.query<{ reserve_quote: string }>('SELECT reserve_quote FROM pool_snapshots ORDER BY pool_id');
      expect(stored.rows[0]?.reserve_quote).toBe('52331970594');
    });
  });

  it('refuses a snapshot for a token that is not in the universe', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const repo = new PgSnapshotRepo(db);
      const tick = new Date('2026-09-05T15:05:00Z');
      const runId = await repo.startRun(tick, tick);
      await expect(repo.insertSnapshots(runId, [row('SundaeSwapV3:a', tick)])).rejects.toThrow(/pool_snapshots_base_unit_fkey/);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:pg -- packages/collector`
Expected: FAIL, `PgSnapshotRepo` not exported.

- [ ] **Step 3: Implement the repository**

`packages/collector/src/repo.ts`:
```ts
import type { Db } from '@ctb/db';
import type { TokenSpec } from '@ctb/universe';
import type { SnapshotRow } from './types.js';

export interface RunError {
  scope: string;
  message: string;
}

export interface RunSummary {
  poolsAttempted: number;
  poolsFailed: number;
  poolsWritten: number;
  providerCalls: number;
  discovered: boolean;
  errors: RunError[];
}

export interface RunRow extends RunSummary {
  id: number;
  tickTs: Date;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface SnapshotRepo {
  syncTokens(tokens: TokenSpec[], seed: { seededAt: string; seedSource: string }): Promise<void>;
  startRun(tickTs: Date, startedAt: Date): Promise<number>;
  /** Returns rows actually inserted; (pool_id, tick_ts) duplicates are skipped, making a re-run of a tick safe. */
  insertSnapshots(runId: number, rows: SnapshotRow[]): Promise<number>;
  finishRun(runId: number, finishedAt: Date, summary: RunSummary): Promise<void>;
  lastRuns(limit: number): Promise<RunRow[]>;
}

const SNAPSHOT_COLS = 13;

export class PgSnapshotRepo implements SnapshotRepo {
  constructor(private readonly db: Db) {}

  async syncTokens(tokens: TokenSpec[], seed: { seededAt: string; seedSource: string }): Promise<void> {
    for (const t of tokens) {
      await this.db.query(
        `INSERT INTO tokens (unit, policy_id, asset_name_hex, ticker, decimals, category, seeded_at, seed_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (unit) DO UPDATE SET ticker = EXCLUDED.ticker, decimals = EXCLUDED.decimals, category = EXCLUDED.category`,
        [t.unit, t.policyId, t.assetNameHex, t.ticker, t.decimals, t.category, seed.seededAt, seed.seedSource],
      );
    }
  }

  async startRun(tickTs: Date, startedAt: Date): Promise<number> {
    const res = await this.db.query<{ id: string }>(
      'INSERT INTO collector_runs (tick_ts, started_at) VALUES ($1, $2) RETURNING id',
      [tickTs, startedAt],
    );
    const id = res.rows[0]?.id;
    if (id === undefined) throw new Error('startRun returned no id');
    return Number(id);
  }

  async insertSnapshots(runId: number, rows: SnapshotRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      const o = i * SNAPSHOT_COLS;
      values.push(
        runId, r.tickTs, r.dex, r.poolId, r.poolAddress, r.baseUnit, r.quoteUnit,
        r.reserveBase.toString(), r.reserveQuote.toString(), r.feeBps, r.poolType,
        r.tvlLovelace.toString(), r.blockHeight, r.observedAt,
      );
      // 14 params per row: run_id + 13 columns
      const p = Array.from({ length: 14 }, (_, k) => `$${o + i + k + 1}`);
      return `(${p.join(', ')})`;
    });
    const res = await this.db.query(
      `INSERT INTO pool_snapshots (run_id, tick_ts, dex, pool_id, pool_address, base_unit, quote_unit,
         reserve_base, reserve_quote, fee_bps, pool_type, tvl_lovelace, block_height, observed_at)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (pool_id, tick_ts) DO NOTHING`,
      values,
    );
    return res.rowCount ?? 0;
  }

  async finishRun(runId: number, finishedAt: Date, s: RunSummary): Promise<void> {
    await this.db.query(
      `UPDATE collector_runs SET finished_at = $2, pools_attempted = $3, pools_failed = $4, pools_written = $5,
         provider_calls = $6, discovered = $7, errors = $8::jsonb WHERE id = $1`,
      [runId, finishedAt, s.poolsAttempted, s.poolsFailed, s.poolsWritten, s.providerCalls, s.discovered, JSON.stringify(s.errors)],
    );
  }

  async lastRuns(limit: number): Promise<RunRow[]> {
    const res = await this.db.query<{
      id: string; tick_ts: Date; started_at: Date; finished_at: Date | null; pools_attempted: number; pools_failed: number;
      pools_written: number; provider_calls: number; discovered: boolean; errors: RunError[];
    }>('SELECT * FROM collector_runs ORDER BY id DESC LIMIT $1', [limit]);
    return res.rows.map((r) => ({
      id: Number(r.id), tickTs: r.tick_ts, startedAt: r.started_at, finishedAt: r.finished_at,
      poolsAttempted: r.pools_attempted, poolsFailed: r.pools_failed, poolsWritten: r.pools_written,
      providerCalls: r.provider_calls, discovered: r.discovered, errors: r.errors,
    }));
  }
}
```

Note on the parameter numbering: each row contributes 14 placeholders. The expression `o + i + k + 1` with `o = i * 13` equals `i * 14 + k + 1`. Keep it as written or simplify to `i * 14 + k + 1`; the test asserts the stored value either way.

Add to `packages/collector/src/index.ts`:
```ts
export { PgSnapshotRepo, type RunError, type RunRow, type RunSummary, type SnapshotRepo } from './repo.js';
```

- [ ] **Step 4: Run the pg tests**

Run: `npm run test:pg -- packages/collector`
Expected: both pass.

- [ ] **Step 5: Lint, commit**

```bash
npm run lint && git add -A && git commit -m "feat(collector): postgres snapshot repository with idempotent tick writes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `@ctb/collector` — Dexter/Blockfrost pool source

**Files:**
- Create: `packages/collector/src/source.ts`, `packages/collector/src/dexterSource.ts`, `packages/collector/test/source.test.ts`, `packages/collector/test/dexterSource.live.test.ts`
- Modify: `packages/collector/src/index.ts`

**Interfaces:**
- Consumes: `Pair` from `@ctb/universe`; `PoolLike`, `Logger` from Task 4; Dexter classes `Dexter`, `Asset`, `BlockfrostProvider`, `LiquidityPool` from `@indigo-labs/dexter`.
- Produces:
  - `interface PoolSource { discover(pairs: Pair[]): Promise<{ pools: PoolLike[]; failures: RunError[] }>; refresh(): Promise<{ pools: PoolLike[]; failures: RunError[] }>; tip(): Promise<{ height: number; time: Date }>; providerCalls(): number; resetProviderCalls(): void; knownPoolCount(): number }`
  - `class DexterPoolSource implements PoolSource { constructor(opts: { blockfrostProjectId: string; blockfrostUrl?: string; log: Logger; venues?: DexName[]; fetch?: typeof fetch }) }`
  - `toPoolLike(pool: LiquidityPoolShape): PoolLike` where `LiquidityPoolShape` is the structural subset of Dexter's class (exported for tests).

- [ ] **Step 1: Write the failing unit tests (no network, no Dexter import)**

`packages/collector/test/source.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { toPoolLike, type LiquidityPoolShape } from '../src/dexterSource.js';

describe('toPoolLike', () => {
  it('maps a Dexter pool with an Asset side', () => {
    const shape: LiquidityPoolShape = {
      dex: 'MinswapV2',
      identifier: 'lp1',
      address: 'addr1_min',
      assetA: 'lovelace',
      assetB: { policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', nameHex: '534e454b', decimals: 0 },
      reserveA: 10n,
      reserveB: 20n,
      poolFeePercent: 0.3,
    };
    expect(toPoolLike(shape)).toEqual({
      dex: 'MinswapV2',
      identifier: 'lp1',
      address: 'addr1_min',
      assetA: 'lovelace',
      assetB: { policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', nameHex: '534e454b' },
      reserveA: 10n,
      reserveB: 20n,
      poolFeePercent: 0.3,
    });
  });

  it('rejects a pool with no address (cannot be refreshed later)', () => {
    const shape: LiquidityPoolShape = {
      dex: 'Splash', identifier: 'x', address: '', assetA: 'lovelace',
      assetB: { policyId: 'a'.repeat(56), nameHex: '00', decimals: 0 }, reserveA: 1n, reserveB: 1n, poolFeePercent: 0,
    };
    expect(() => toPoolLike(shape)).toThrow(/no address/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/collector/test/source.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the source interface and the Dexter adapter**

`packages/collector/src/source.ts`:
```ts
import type { Pair } from '@ctb/universe';
import type { RunError } from './repo.js';
import type { PoolLike } from './types.js';

export interface SourceResult {
  pools: PoolLike[];
  failures: RunError[];
}

/** What the tick runner needs from the chain. Implemented by DexterPoolSource; faked in tests. */
export interface PoolSource {
  /** Expensive: scans every pool of every venue on-chain, keeps the matches for `refresh`. */
  discover(pairs: Pair[]): Promise<SourceResult>;
  /** Cheap: one provider call per known pool. */
  refresh(): Promise<SourceResult>;
  tip(): Promise<{ height: number; time: Date }>;
  providerCalls(): number;
  resetProviderCalls(): void;
  knownPoolCount(): number;
}
```

`packages/collector/src/dexterSource.ts`:
```ts
import { Asset, BlockfrostProvider, Dexter, type LiquidityPool } from '@indigo-labs/dexter';
import type { Pair } from '@ctb/universe';
import type { RunError } from './repo.js';
import type { PoolSource, SourceResult } from './source.js';
import { poolIdOf } from './snapshot.js';
import type { Logger, PoolLike } from './types.js';
import { VENUE_NAMES, type DexName } from './venues.js';

/** Structural view of Dexter's LiquidityPool so unit tests need no Dexter import. */
export interface LiquidityPoolShape {
  dex: string;
  identifier: string;
  address: string;
  assetA: 'lovelace' | { policyId: string; nameHex: string; decimals: number };
  assetB: 'lovelace' | { policyId: string; nameHex: string; decimals: number };
  reserveA: bigint;
  reserveB: bigint;
  poolFeePercent: number;
}

export function toPoolLike(p: LiquidityPoolShape): PoolLike {
  if (!p.address) throw new Error(`pool ${p.dex}:${p.identifier} has no address; it cannot be refreshed`);
  const side = (a: LiquidityPoolShape['assetA']) => (a === 'lovelace' ? 'lovelace' : { policyId: a.policyId, nameHex: a.nameHex });
  return {
    dex: p.dex,
    identifier: p.identifier,
    address: p.address,
    assetA: side(p.assetA),
    assetB: side(p.assetB),
    reserveA: p.reserveA,
    reserveB: p.reserveB,
    poolFeePercent: p.poolFeePercent,
  };
}

/** Counts provider method calls so each tick can report its Blockfrost cost. Paginated calls count once per method call. */
class CountingBlockfrostProvider extends BlockfrostProvider {
  calls = 0;
  override utxos(...args: Parameters<BlockfrostProvider['utxos']>) { this.calls++; return super.utxos(...args); }
  override transactionUtxos(...args: Parameters<BlockfrostProvider['transactionUtxos']>) { this.calls++; return super.transactionUtxos(...args); }
  override assetTransactions(...args: Parameters<BlockfrostProvider['assetTransactions']>) { this.calls++; return super.assetTransactions(...args); }
  override assetAddresses(...args: Parameters<BlockfrostProvider['assetAddresses']>) { this.calls++; return super.assetAddresses(...args); }
  override datumValue(...args: Parameters<BlockfrostProvider['datumValue']>) { this.calls++; return super.datumValue(...args); }
}

export interface DexterPoolSourceOptions {
  blockfrostProjectId: string;
  blockfrostUrl?: string;
  log: Logger;
  venues?: DexName[];
  fetch?: typeof fetch;
}

export class DexterPoolSource implements PoolSource {
  private readonly dexter: Dexter;
  private readonly provider: CountingBlockfrostProvider;
  private readonly known = new Map<string, LiquidityPool>();
  private readonly venues: DexName[];
  private readonly url: string;
  private readonly projectId: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DexterPoolSourceOptions) {
    this.url = opts.blockfrostUrl ?? 'https://cardano-mainnet.blockfrost.io/api/v0';
    this.projectId = opts.blockfrostProjectId;
    this.log = opts.log;
    this.venues = opts.venues ?? VENUE_NAMES;
    this.fetchImpl = opts.fetch ?? fetch;
    this.provider = new CountingBlockfrostProvider({ url: this.url, projectId: this.projectId }, { timeout: 20_000, retries: 2 });
    // shouldFallbackToApi false: an on-chain failure must surface as a failure, not as a quietly different data source.
    this.dexter = new Dexter({ shouldFetchMetadata: false, shouldFallbackToApi: false }, { timeout: 20_000, retries: 2 });
    this.dexter.withDataProvider(this.provider);
  }

  providerCalls(): number { return this.provider.calls; }
  resetProviderCalls(): void { this.provider.calls = 0; }
  knownPoolCount(): number { return this.known.size; }

  async discover(pairs: Pair[]): Promise<SourceResult> {
    const tokenPairs = pairs.map((p) => ['lovelace' as const, new Asset(p.base.policyId, p.base.assetNameHex, p.base.decimals)]);
    const failures: RunError[] = [];
    const found: PoolLike[] = [];
    this.known.clear();
    // One request per venue so a failing venue is attributable instead of vanishing into an empty array.
    for (const venue of this.venues) {
      try {
        const pools = await this.dexter.newFetchRequest().onDexs(venue).forTokenPairs(tokenPairs).getLiquidityPools();
        for (const pool of pools) {
          const like = toPoolLike(pool as unknown as LiquidityPoolShape);
          this.known.set(poolIdOf(like), pool);
          found.push(like);
        }
        this.log.info({ venue, pools: pools.length }, 'discovered pools');
      } catch (err) {
        failures.push({ scope: `discover:${venue}`, message: (err as Error).message ?? String(err) });
        this.log.warn({ venue, err: (err as Error).message }, 'discovery failed for venue');
      }
    }
    return { pools: found, failures };
  }

  async refresh(): Promise<SourceResult> {
    const entries = [...this.known.entries()];
    const settled = await Promise.allSettled(
      entries.map(([, pool]) => this.dexter.newFetchRequest().getLiquidityPoolState(pool)),
    );
    const pools: PoolLike[] = [];
    const failures: RunError[] = [];
    settled.forEach((r, i) => {
      const poolId = entries[i]?.[0] ?? '?';
      if (r.status === 'fulfilled' && r.value) {
        this.known.set(poolId, r.value);
        pools.push(toPoolLike(r.value as unknown as LiquidityPoolShape));
      } else {
        const message = r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason) : 'no state returned';
        failures.push({ scope: `refresh:${poolId}`, message });
      }
    });
    return { pools, failures };
  }

  async tip(): Promise<{ height: number; time: Date }> {
    const res = await this.fetchImpl(`${this.url}/blocks/latest`, { headers: { project_id: this.projectId } });
    if (!res.ok) throw new Error(`blockfrost /blocks/latest returned ${res.status}`);
    const body = (await res.json()) as { height?: number; time?: number };
    if (typeof body.height !== 'number' || typeof body.time !== 'number') throw new Error('blockfrost /blocks/latest: missing height/time');
    return { height: body.height, time: new Date(body.time * 1000) };
  }
}
```

Add to `packages/collector/src/index.ts`:
```ts
export type { PoolSource, SourceResult } from './source.js';
export { DexterPoolSource, toPoolLike, type DexterPoolSourceOptions, type LiquidityPoolShape } from './dexterSource.js';
```

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run packages/collector/test/source.test.ts`
Expected: 2 passed. If Vitest fails to load `@indigo-labs/dexter` (lucid WASM) when importing `dexterSource.ts`, move `toPoolLike` and `LiquidityPoolShape` into a new `packages/collector/src/poolShape.ts` that imports nothing from Dexter, re-export from index, and point the test there. The live test below still covers the adapter.

- [ ] **Step 5: Write the opt-in live test**

`packages/collector/test/dexterSource.live.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DexterPoolSource } from '../src/index.js';

const LIVE = process.env.RUN_LIVE_TESTS === '1' && !!process.env.BLOCKFROST_PROJECT_ID;
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!LIVE)('DexterPoolSource (live Blockfrost)', () => {
  it('discovers and refreshes SNEK/ADA on SundaeSwapV3, reporting provider calls', async () => {
    const source = new DexterPoolSource({
      blockfrostProjectId: process.env.BLOCKFROST_PROJECT_ID as string,
      log,
      venues: ['SundaeSwapV3'],
    });
    const pair = {
      base: { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme',
        unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b' },
      quote: 'lovelace' as const,
    };
    const tip = await source.tip();
    expect(tip.height).toBeGreaterThan(10_000_000);

    const d = await source.discover([pair]);
    expect(d.failures).toEqual([]);
    expect(d.pools.length).toBeGreaterThanOrEqual(1);
    const discoverCalls = source.providerCalls();
    expect(d.pools[0]?.reserveA).toBeGreaterThan(0n);

    source.resetProviderCalls();
    const r = await source.refresh();
    expect(r.failures).toEqual([]);
    expect(r.pools.length).toBe(d.pools.length);
    const refreshCalls = source.providerCalls();
    // Record these two numbers in the M1 report; they size the tick budget.
    console.log(`SundaeSwapV3 SNEK: discover=${discoverCalls} calls, refresh=${refreshCalls} calls for ${r.pools.length} pools`);
    expect(refreshCalls).toBeLessThanOrEqual(2 * r.pools.length);
  }, 120_000);
});
```

- [ ] **Step 6: Run the live test once (needs your Blockfrost key in `.env`)**

Run: `set -a && source .env && set +a && npm run test:live`
Expected: 1 passed and a printed call count. Paste the printed line into the commit body.

- [ ] **Step 7: Lint, commit**

```bash
npm run lint && git add -A && git commit -m "feat(collector): Dexter/Blockfrost pool source with per-venue discovery and per-pool refresh

Live: <paste the printed discover/refresh call counts here>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `@ctb/collector` — tick runner

**Files:**
- Create: `packages/collector/src/tick.ts`, `packages/collector/test/tick.test.ts`
- Modify: `packages/collector/src/index.ts`

**Interfaces:**
- Consumes: `PoolSource`, `SourceResult` (Task 6); `SnapshotRepo`, `RunSummary` (Task 5); `poolToSnapshot`, `bucketTick` (Task 4); `Pair` (`@ctb/universe`).
- Produces:
  - `interface CollectorState { lastDiscoveryAt: Date | null }`
  - `interface TickDeps { source: PoolSource; repo: SnapshotRepo; pairs: Pair[]; log: Logger; now: () => Date; intervalSec: number; rediscoverAfterMs: number; state: CollectorState }`
  - `runTick(deps: TickDeps): Promise<RunSummary>` (never throws for source errors; throws only if the repo cannot start or finish the run)

- [ ] **Step 1: Write the failing tests with fakes**

`packages/collector/test/tick.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Pair } from '@ctb/universe';
import {
  runTick, type CollectorState, type PoolLike, type PoolSource, type RunSummary, type SnapshotRepo, type SnapshotRow, type SourceResult,
} from '../src/index.js';

const SNEK_PAIR: Pair = {
  base: { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme',
    unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b' },
  quote: 'lovelace',
};

const pool = (dex: string, id: string): PoolLike => ({
  dex, identifier: id, address: `addr_${id}`, assetA: 'lovelace',
  assetB: { policyId: SNEK_PAIR.base.policyId, nameHex: SNEK_PAIR.base.assetNameHex },
  reserveA: 100n, reserveB: 50n, poolFeePercent: 0.3,
});

class FakeSource implements PoolSource {
  discoverCalls = 0;
  refreshCalls = 0;
  calls = 0;
  constructor(private readonly pools: PoolLike[], private readonly tipFails = false) {}
  async discover(): Promise<SourceResult> { this.discoverCalls++; this.calls += 10; return { pools: this.pools, failures: [] }; }
  async refresh(): Promise<SourceResult> { this.refreshCalls++; this.calls += this.pools.length; return { pools: this.pools, failures: [] }; }
  async tip() { if (this.tipFails) throw new Error('blockfrost down'); return { height: 42, time: new Date() }; }
  providerCalls() { return this.calls; }
  resetProviderCalls() { this.calls = 0; }
  knownPoolCount() { return this.discoverCalls === 0 ? 0 : this.pools.length; }
}

class FakeRepo implements SnapshotRepo {
  rows: SnapshotRow[] = [];
  summaries: RunSummary[] = [];
  nextId = 1;
  async syncTokens() {}
  async startRun() { return this.nextId++; }
  async insertSnapshots(_runId: number, rows: SnapshotRow[]) { this.rows.push(...rows); return rows.length; }
  async finishRun(_runId: number, _at: Date, s: RunSummary) { this.summaries.push(s); }
  async lastRuns() { return []; }
}

const log = { info: () => {}, warn: () => {}, error: () => {} };
const fixedNow = () => new Date('2026-09-05T15:07:41Z');

function deps(source: PoolSource, repo: SnapshotRepo, state: CollectorState = { lastDiscoveryAt: null }) {
  return { source, repo, pairs: [SNEK_PAIR], log, now: fixedNow, intervalSec: 300, rediscoverAfterMs: 24 * 3600 * 1000, state };
}

describe('runTick', () => {
  it('discovers on the first tick, refreshes on the next, writes snapshots at the bucketed tick', async () => {
    const source = new FakeSource([pool('MinswapV2', 'a'), pool('SundaeSwapV3', 'b')]);
    const repo = new FakeRepo();
    const state: CollectorState = { lastDiscoveryAt: null };
    const s1 = await runTick(deps(source, repo, state));
    expect(s1).toMatchObject({ discovered: true, poolsAttempted: 2, poolsWritten: 2, poolsFailed: 0, errors: [] });
    expect(repo.rows[0]?.tickTs).toEqual(new Date('2026-09-05T15:05:00Z'));
    expect(repo.rows[0]?.blockHeight).toBe(42);
    const s2 = await runTick(deps(source, repo, state));
    expect(s2.discovered).toBe(false);
    expect(source.discoverCalls).toBe(1);
    expect(source.refreshCalls).toBe(1);
    expect(s2.providerCalls).toBe(2); // one per pool, counter reset between ticks
  });

  it('records a mapping failure per pool and still writes the others', async () => {
    const source = new FakeSource([pool('MinswapV2', 'a'), pool('FutureSwap', 'z')]);
    const repo = new FakeRepo();
    const s = await runTick(deps(source, repo));
    expect(s.poolsWritten).toBe(1);
    expect(s.poolsFailed).toBe(1);
    expect(s.errors[0]?.scope).toBe('map:FutureSwap:z');
    expect(s.errors[0]?.message).toMatch(/unknown venue/);
  });

  it('finishes the run with an error and no snapshots when the tip cannot be read', async () => {
    const source = new FakeSource([pool('MinswapV2', 'a')], true);
    const repo = new FakeRepo();
    const s = await runTick(deps(source, repo));
    expect(repo.rows).toHaveLength(0);
    expect(repo.summaries).toHaveLength(1);
    expect(s.errors[0]).toEqual({ scope: 'tip', message: 'blockfrost down' });
  });

  it('rediscovers when the last discovery is older than the threshold', async () => {
    const source = new FakeSource([pool('MinswapV2', 'a')]);
    const repo = new FakeRepo();
    const state: CollectorState = { lastDiscoveryAt: new Date('2026-09-04T10:00:00Z') };
    // knownPoolCount() is 0 until discover() ran, so this also covers "process restarted"
    const s = await runTick(deps(source, repo, state));
    expect(s.discovered).toBe(true);
    expect(state.lastDiscoveryAt).toEqual(fixedNow());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/collector/test/tick.test.ts`
Expected: FAIL, `runTick` not exported.

- [ ] **Step 3: Implement the tick**

`packages/collector/src/tick.ts`:
```ts
import type { Pair } from '@ctb/universe';
import type { RunError, RunSummary, SnapshotRepo } from './repo.js';
import { bucketTick, poolIdOf, poolToSnapshot } from './snapshot.js';
import type { PoolSource } from './source.js';
import type { Logger, SnapshotRow } from './types.js';

export interface CollectorState {
  lastDiscoveryAt: Date | null;
}

export interface TickDeps {
  source: PoolSource;
  repo: SnapshotRepo;
  pairs: Pair[];
  log: Logger;
  now: () => Date;
  intervalSec: number;
  rediscoverAfterMs: number;
  state: CollectorState;
}

/**
 * One collector tick. Source failures are recorded on the run row, never thrown, so the loop keeps going
 * and the gap is visible in `collector_runs`. Only repository failures propagate.
 */
export async function runTick(d: TickDeps): Promise<RunSummary> {
  const startedAt = d.now();
  const tickTs = bucketTick(startedAt, d.intervalSec);
  const runId = await d.repo.startRun(tickTs, startedAt);
  d.source.resetProviderCalls();
  const errors: RunError[] = [];
  const summary: RunSummary = { poolsAttempted: 0, poolsFailed: 0, poolsWritten: 0, providerCalls: 0, discovered: false, errors };

  const finish = async (): Promise<RunSummary> => {
    summary.providerCalls = d.source.providerCalls();
    await d.repo.finishRun(runId, d.now(), summary);
    d.log.info({ runId, tickTs, ...summary, errors: summary.errors.length }, 'tick finished');
    return summary;
  };

  let tip: { height: number; time: Date };
  try {
    tip = await d.source.tip();
  } catch (err) {
    errors.push({ scope: 'tip', message: (err as Error).message ?? String(err) });
    return finish();
  }

  const stale =
    d.state.lastDiscoveryAt === null ||
    d.source.knownPoolCount() === 0 ||
    startedAt.getTime() - d.state.lastDiscoveryAt.getTime() > d.rediscoverAfterMs;

  const result = stale ? await d.source.discover(d.pairs) : await d.source.refresh();
  if (stale) {
    summary.discovered = true;
    d.state.lastDiscoveryAt = startedAt;
  }
  errors.push(...result.failures);

  const rows: SnapshotRow[] = [];
  summary.poolsAttempted = result.pools.length + result.failures.filter((f) => f.scope.startsWith('refresh:')).length;
  for (const pool of result.pools) {
    try {
      rows.push(poolToSnapshot(pool, { tickTs, blockHeight: tip.height, observedAt: d.now() }));
    } catch (err) {
      errors.push({ scope: `map:${poolIdOf(pool)}`, message: (err as Error).message ?? String(err) });
    }
  }
  summary.poolsFailed = summary.poolsAttempted - rows.length;
  summary.poolsWritten = await d.repo.insertSnapshots(runId, rows);
  return finish();
}
```

Add to `packages/collector/src/index.ts`:
```ts
export { runTick, type CollectorState, type TickDeps } from './tick.js';
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/collector/test/tick.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Lint, commit**

```bash
npm run lint && git add -A && git commit -m "feat(collector): tick runner with daily discovery, per-tick refresh, counted failures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `@ctb/cli` — `migrate`, `collect`, `status`

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/src/main.ts`, `packages/cli/src/config.ts`, `packages/cli/src/schedule.ts`, `packages/cli/src/commands/migrate.ts`, `packages/cli/src/commands/collect.ts`, `packages/cli/src/commands/status.ts`, `packages/cli/test/config.test.ts`, `packages/cli/test/schedule.test.ts`

**Interfaces:**
- Consumes: `createPool`, `migrate` (`@ctb/db`); `loadUniverse` (`@ctb/universe`); `DexterPoolSource`, `PgSnapshotRepo`, `runTick`, `CollectorState` (`@ctb/collector`).
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv, needs: { blockfrost: boolean }): Config` with `interface Config { databaseUrl: string; blockfrostProjectId: string | null; intervalSec: number; logLevel: string }`
  - `msUntilNextBoundary(now: Date, intervalSec: number): number`

- [ ] **Step 1: Package manifest**

`packages/cli/package.json`:
```json
{
  "name": "@ctb/cli",
  "private": true,
  "type": "module",
  "exports": "./src/main.ts",
  "dependencies": {
    "@ctb/collector": "*",
    "@ctb/db": "*",
    "@ctb/universe": "*",
    "dotenv": "^16.4.0",
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0",
    "zod": "^3.23.0"
  }
}
```
Run: `npm install`

- [ ] **Step 2: Write the failing tests**

`packages/cli/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://ctb:x@localhost:5433/ctb' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base, { blockfrost: false });
    expect(c).toEqual({ databaseUrl: base.DATABASE_URL, blockfrostProjectId: null, intervalSec: 300, logLevel: 'info' });
  });

  it('requires BLOCKFROST_PROJECT_ID only when asked', () => {
    expect(() => loadConfig(base, { blockfrost: true })).toThrow(/BLOCKFROST_PROJECT_ID/);
    expect(loadConfig({ ...base, BLOCKFROST_PROJECT_ID: 'mainnetabc' }, { blockfrost: true }).blockfrostProjectId).toBe('mainnetabc');
  });

  it('rejects a non-integer or too-short interval', () => {
    expect(() => loadConfig({ ...base, COLLECT_INTERVAL_SECONDS: 'soon' }, { blockfrost: false })).toThrow(/COLLECT_INTERVAL_SECONDS/);
    expect(() => loadConfig({ ...base, COLLECT_INTERVAL_SECONDS: '10' }, { blockfrost: false })).toThrow(/COLLECT_INTERVAL_SECONDS/);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({}, { blockfrost: false })).toThrow(/DATABASE_URL/);
  });
});
```

`packages/cli/test/schedule.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { msUntilNextBoundary } from '../src/schedule.js';

describe('msUntilNextBoundary', () => {
  it('waits to the next interval boundary', () => {
    expect(msUntilNextBoundary(new Date('2026-09-05T15:07:41Z'), 300)).toBe(139_000);
  });
  it('waits a full interval when exactly on a boundary', () => {
    expect(msUntilNextBoundary(new Date('2026-09-05T15:05:00Z'), 300)).toBe(300_000);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run packages/cli`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement config, schedule, commands, main**

`packages/cli/src/config.ts`:
```ts
import { z } from 'zod';

export interface Config {
  databaseUrl: string;
  blockfrostProjectId: string | null;
  intervalSec: number;
  logLevel: string;
}

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BLOCKFROST_PROJECT_ID: z.string().min(1).optional(),
  COLLECT_INTERVAL_SECONDS: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 300 : Number(v)))
    .refine((n) => Number.isInteger(n) && n >= 60, 'COLLECT_INTERVAL_SECONDS must be an integer >= 60'),
  LOG_LEVEL: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv, needs: { blockfrost: boolean }): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`config: ${first?.path.join('.') || 'env'}: ${first?.message ?? 'invalid'}`);
  }
  const v = parsed.data;
  if (needs.blockfrost && !v.BLOCKFROST_PROJECT_ID) throw new Error('config: BLOCKFROST_PROJECT_ID is required for this command');
  return {
    databaseUrl: v.DATABASE_URL,
    blockfrostProjectId: v.BLOCKFROST_PROJECT_ID ?? null,
    intervalSec: v.COLLECT_INTERVAL_SECONDS,
    logLevel: v.LOG_LEVEL ?? 'info',
  };
}
```

`packages/cli/src/schedule.ts`:
```ts
/** Milliseconds until the next interval boundary, so ticks land at :00, :05, :10 regardless of start time. */
export function msUntilNextBoundary(now: Date, intervalSec: number): number {
  const ms = intervalSec * 1000;
  const next = (Math.floor(now.getTime() / ms) + 1) * ms;
  return next - now.getTime();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
```

`packages/cli/src/commands/migrate.ts`:
```ts
import { createPool, migrate } from '@ctb/db';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

export async function migrateCommand(log: Logger): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: false });
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const ran = await migrate(db);
    log.info({ applied: ran }, ran.length ? 'migrations applied' : 'schema already current');
  } finally {
    await db.end();
  }
}
```

`packages/cli/src/commands/collect.ts`:
```ts
import { DexterPoolSource, PgSnapshotRepo, runTick, type CollectorState } from '@ctb/collector';
import { createPool } from '@ctb/db';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { msUntilNextBoundary, sleep } from '../schedule.js';

const REDISCOVER_AFTER_MS = 24 * 60 * 60 * 1000;

export async function collectCommand(log: Logger, opts: { once: boolean }): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: true });
  const universe = await loadUniverse();
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  const repo = new PgSnapshotRepo(db);
  await repo.syncTokens(universe.tokens, { seededAt: universe.seededAt, seedSource: universe.seedSource });
  const source = new DexterPoolSource({ blockfrostProjectId: cfg.blockfrostProjectId as string, log });
  const state: CollectorState = { lastDiscoveryAt: null };
  const stop = new AbortController();
  const onSignal = (sig: string) => { log.info({ sig }, 'stopping after current tick'); stop.abort(); };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  log.info({ pairs: universe.pairs.length, intervalSec: cfg.intervalSec, once: opts.once }, 'collector starting');
  try {
    do {
      const tickDeps = { source, repo, pairs: universe.pairs, log, now: () => new Date(), intervalSec: cfg.intervalSec, rediscoverAfterMs: REDISCOVER_AFTER_MS, state };
      try {
        await runTick(tickDeps);
      } catch (err) {
        // Repository failure: the run row could not be written, so log loudly and keep the loop alive.
        log.error({ err: (err as Error).message }, 'tick failed before it could be recorded');
      }
      if (opts.once || stop.signal.aborted) break;
      await sleep(msUntilNextBoundary(new Date(), cfg.intervalSec), stop.signal);
    } while (!stop.signal.aborted);
  } finally {
    await db.end();
    log.info({}, 'collector stopped');
  }
}
```

`packages/cli/src/commands/status.ts`:
```ts
import { PgSnapshotRepo } from '@ctb/collector';
import { createPool } from '@ctb/db';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

export async function statusCommand(log: Logger): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: false });
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    const repo = new PgSnapshotRepo(db);
    const runs = await repo.lastRuns(10);
    const perDex = await db.query<{ dex: string; pools: string; tick_ts: Date }>(
      `SELECT dex, count(*) AS pools, tick_ts FROM pool_snapshots
       WHERE tick_ts = (SELECT max(tick_ts) FROM pool_snapshots) GROUP BY dex, tick_ts ORDER BY dex`,
    );
    const gaps = await db.query<{ missing_ticks: string }>(
      `WITH t AS (SELECT DISTINCT tick_ts FROM collector_runs WHERE tick_ts > now() - interval '24 hours')
       SELECT (extract(epoch FROM (now() - (now() - interval '24 hours'))) / $1)::int - count(*) AS missing_ticks FROM t`,
      [cfg.intervalSec],
    );
    // Plain output is intended here: status is an operator command, not a request path.
    console.table(runs.map((r) => ({
      id: r.id, tick: r.tickTs.toISOString(), finished: r.finishedAt ? 'yes' : 'NO', attempted: r.poolsAttempted,
      written: r.poolsWritten, failed: r.poolsFailed, calls: r.providerCalls, discovered: r.discovered, errors: r.errors.length,
    })));
    console.table(perDex.rows.map((r) => ({ dex: r.dex, pools: Number(r.pools), tick: r.tick_ts.toISOString() })));
    console.log(`ticks missing in last 24h (approx): ${gaps.rows[0]?.missing_ticks ?? 'n/a'}`);
  } finally {
    await db.end();
  }
}
```

`packages/cli/src/main.ts`:
```ts
import 'dotenv/config';
import pino from 'pino';
import { collectCommand } from './commands/collect.js';
import { migrateCommand } from './commands/migrate.js';
import { statusCommand } from './commands/status.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.stdout.isTTY ? { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } : undefined,
});

const [cmd, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (cmd) {
    case 'migrate':
      return migrateCommand(log);
    case 'collect':
      return collectCommand(log, { once: rest.includes('--once') });
    case 'status':
      return statusCommand(log);
    default:
      console.error('usage: tsx packages/cli/src/main.ts <migrate|collect [--once]|status>');
      process.exitCode = 2;
  }
}

main().catch((err: Error) => {
  log.error({ err: err.message }, 'command failed');
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run the unit tests**

Run: `npx vitest run packages/cli`
Expected: 6 passed.

- [ ] **Step 6: End-to-end on the compose database with a single tick**

```bash
docker compose up -d postgres
npm run migrate
npm run collect -- --once
npm run status
```
Expected: `migrate` logs `migrations applied: ["0001_core.sql"]` the first time; `collect --once` logs one `discovered pools` line per venue then `tick finished` with `poolsWritten > 0` and `discovered: true`; `status` shows one run row with `finished: yes` and a per-DEX pool table. Venues that fail discovery appear under `errors` on the run row; that is expected data, not a blocker, and goes into the M1 report.

Verify in SQL:
```bash
docker exec -it ctb_postgres psql -U ctb -d ctb -c "SELECT id, tick_ts, pools_attempted, pools_written, pools_failed, provider_calls, discovered, jsonb_array_length(errors) AS errs FROM collector_runs ORDER BY id DESC LIMIT 3;"
docker exec -it ctb_postgres psql -U ctb -d ctb -c "SELECT t.ticker, s.dex, s.reserve_base, s.reserve_quote, s.fee_bps FROM pool_snapshots s JOIN tokens t ON t.unit = s.base_unit ORDER BY s.tvl_lovelace DESC LIMIT 10;"
```

- [ ] **Step 7: Lint, commit, open the PR for M0**

```bash
npm run lint && git add -A && git commit -m "feat(cli): migrate, collect (aligned to interval boundaries), status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Then (after the GitHub remote exists, see Open items) `gh pr create --base main --title "M0: scaffold, schema, universe, collector" --body "Implements docs/plans/2026-09-05-m0-m1-collector.md Tasks 1-8. Spec: docs/specs/2026-09-05-paper-trading-foundation.md"`.

---

### Task 9: M1 acceptance — 24 hours unattended, measured budget, written report

**Files:**
- Create: `docs/ops/2026-09-XX-m1-report.md` (replace XX with the day the run ends)

**Interfaces:**
- Consumes: everything above. Produces the numbers Plan 2 needs: provider calls per refresh tick, per discovery tick, pools per venue, venues that fail, and whether the 5-minute interval fits the Blockfrost tier you signed up for.

- [ ] **Step 1: Start the collector in the background on the Mac**

```bash
cd ~/code/cardano-trading-bots && set -a && source .env && set +a
nohup npm run collect > collect.log 2>&1 &
echo $! > collect.pid
```
Add `collect.log` and `collect.pid` to `.gitignore` in this commit.

- [ ] **Step 2: After 1 hour, check the first dozen ticks**

```bash
npm run status
grep -c '"msg":"tick finished"' collect.log
```
Expected: about 12 run rows, all `finished: yes`, `missing_ticks` 0 or 1, `provider_calls` on refresh ticks roughly equal to pool count. If `provider_calls` on refresh ticks exceeds `(50_000 / 288) = 173` per tick, stop and raise `COLLECT_INTERVAL_SECONDS` to 600 before continuing; record the decision.

- [ ] **Step 3: After 24 hours, run the acceptance queries**

```sql
-- Liveness: every 5-minute bucket present?
SELECT count(*) AS ticks, min(tick_ts), max(tick_ts),
       (extract(epoch FROM max(tick_ts) - min(tick_ts)) / 300)::int + 1 AS expected
FROM collector_runs;

-- Budget: calls per tick split by discovery vs refresh
SELECT discovered, count(*) AS ticks, round(avg(provider_calls)) AS avg_calls, max(provider_calls) AS max_calls,
       round(avg(extract(epoch FROM finished_at - started_at))) AS avg_seconds
FROM collector_runs GROUP BY discovered;

-- Coverage: pools per venue per token in the latest tick
SELECT t.ticker, s.dex, count(*) AS pools, max(s.tvl_lovelace) AS deepest_tvl
FROM pool_snapshots s JOIN tokens t ON t.unit = s.base_unit
WHERE s.tick_ts = (SELECT max(tick_ts) FROM pool_snapshots)
GROUP BY t.ticker, s.dex ORDER BY t.ticker, s.dex;

-- Tokens with no pool anywhere (need GeckoTerminal or removal in Plan 2)
SELECT t.ticker FROM tokens t WHERE NOT EXISTS (SELECT 1 FROM pool_snapshots s WHERE s.base_unit = t.unit);

-- Recurring errors
SELECT e->>'scope' AS scope, count(*) FROM collector_runs, jsonb_array_elements(errors) e GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

- [ ] **Step 4: Write the report**

`docs/ops/2026-09-XX-m1-report.md` must contain: the Blockfrost tier and its documented daily limit (from your account page, with the date read); the five query outputs pasted verbatim; the chosen interval and why; venues that never returned pools and whether that is a Dexter limitation or a Blockfrost error; the list of tokens with zero pools; the git sha the collector ran on (`git rev-parse HEAD`). End with a one-line verdict: "M1 met" or "M1 not met because …".

- [ ] **Step 5: Stop the collector, commit the report on its own branch**

```bash
kill "$(cat collect.pid)"
git checkout main && git pull --ff-only && git checkout -b docs/m1-report
git add docs/ops .gitignore && git commit -m "docs(ops): M1 24h collector report

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Open items the founder decides (do not block Tasks 1-8)

1. **GitHub remote.** Which org and visibility for `cardano-trading-bots`. Tasks 1-8 work locally; PRs and CI need the remote.
2. **Blockfrost account.** Sign up, read the free-tier daily limit and burst on the account page, put the project id in `.env`. Needed from Task 6 Step 6 onward.
3. **Interval fallback.** If M1 shows the 5-minute budget does not fit, the fallback is 10 minutes, not a paid tier. Confirm or override.

## Plan self-review (done at writing time)

- Spec coverage: §4.1 universe = Task 3; §4.2 collector = Tasks 4-8; §5 tables `tokens`, `collector_runs`, `pool_snapshots` = Task 2 (remaining tables are Plan 2); §6 fail-closed items covered: invalid universe (T3), unknown pool type via venue table + DB CHECK (T2, T4), counted skips (T7); §7 determinism/`volume`-column guards belong to Plan 2 where those tables exist; §8 M0 = T1-T8, M1 = T9.
- Deviation from spec, recorded: spec §4.2 said "one `pool_snapshots` row per pool per tick" with a per-pair failure count; the implementation counts per pool (`pools_attempted/failed`) because Dexter refresh is per pool. Spec text stays; this plan is the finer grain.
- Type consistency checked across tasks: `PoolLike`, `SnapshotRow`, `RunSummary`, `RunError`, `SnapshotRepo`, `PoolSource`, `SourceResult`, `CollectorState`, `TickDeps`, `Logger` are defined once and used with the same names and shapes in Tasks 4-8.
