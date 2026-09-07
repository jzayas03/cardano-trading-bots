# M4a: reports package, dashboard server, health page, runs list and detail

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run dashboard` serves a read-only, localhost-only site with a health board, a runs list and a run detail page whose every number comes from the CLI's own pure functions, with a SELECT-only database role, a smoke test over every route, and a guard that fails if the dashboard package ever computes a number of its own.

**Architecture:** Two new packages. `@ctb/reports` holds the pure report functions the CLI already uses (formatting, run summaries, digest lines, doctor checks, compare/sweep/grid rows, heartbeat liveness), extracted from `packages/cli` so the CLI and the dashboard both import them and neither imports the other. `@ctb/dashboard` is a Node `http` server with one router, HTML template functions per page, one read-only query module, and a vendored uPlot. The digest's SQL moves from the CLI into `@ctb/collector`, which owns the tables it reads. Migration 0006 adds the `ctb_dashboard` role.

**Tech Stack:** unchanged (Node 24, TypeScript strict, tsx, Vitest, pg, zod, pino). No new runtime dependency: uPlot is checked in as two files.

**Spec:** `docs/specs/2026-09-07-m4-dashboard.md` (§3 boundaries, §4 package and §4.1 the one rule, §4.2 pages `/`, `/runs`, `/runs/:id`, §4.3 data access, §5 role, §6 errors, §7 tests, §8 M4a).

**Earlier plans:** `docs/plans/2026-09-05-m0-m1-collector.md`, `docs/plans/2026-09-06-m2-candles-engine.md`, `docs/plans/2026-09-06-m3-paper-mode.md` (all merged).

## Facts verified on 2026-09-07 (do not re-derive; read from `main` at 2dfc398)

- Pure report code in `packages/cli/src` today: `commands/report.ts` exports `dayWindow`, `summarizeDay`, `summarizeRun` (= `summarizeDay`), `adaStr`, `coverageLine`, `feedCountersLine`, `printReport`, `printDayReport`, `parseCompareList`, `parseReportArgs`, `writeCsvExport`, `printCompare`; private `resumesOf`, `printPersistedHeadline`, `printPaperStatusLines`. `commands/status.ts` exports `heartbeatAgeCell`, `isHeartbeatStale`, `parseStatusArgs`, `loadDigestInput`, `statusCommand`. `digest.ts` (`BLOCKFROST_FREE_DAILY_QUOTA`, `QUOTA_OK_BELOW`, `MIN_PROJECTION_ELAPSED_SEC`, `DigestInput`, `utcMidnight`, `digestLines`) imports nothing. `doctor.ts` (checks + `verdict`) imports `DEFAULT_COLLECT_INTERVAL_SEC` from `config.ts`. `compare.ts` (`compareRows`, `compareRunRows`, `sweepRows`) imports `adaStr`, `summarizeRun` from `commands/report.js` and `heartbeatAgeCell` from `commands/status.js`. `grid.ts` (`parseGridArg`, `gridCombinations`, `gridRows`, `gridWarning`) imports `adaStr`. `csv.ts` imports only engine types. `config.ts` exports `DEFAULT_COLLECT_INTERVAL_SEC = 600`, `loadConfig`, `Config`.
- Tests importing those paths: `compare.test.ts`, `csv.test.ts`, `digest.test.ts`, `digest.pg.test.ts`, `doctor.test.ts`, `grid.test.ts`, `paperReport.pg.test.ts`, `report.test.ts`, `reportCompare.test.ts`, `reportCsv.test.ts`, `reportDay.test.ts`, `status.test.ts`, `sweep.test.ts`; and `src/compare.ts`, `src/grid.ts`, `src/main.ts`. They keep working through re-exports (Task 1).
- `loadDigestInput(db, intervalSec, venuesConfigured, now)` in `commands/status.ts` reads `collector_runs`, `pool_snapshots`, `tokens`; `PgSnapshotRepo` (`packages/collector/src/repo.ts`, `constructor(private readonly db: Db)`) owns those tables. `digest.pg.test.ts` exercises it with `withTestSchema` from `packages/db/test/helpers.ts`.
- Engine: `RunRow` (`id, mode, strategyId, params, gitSha, baseUnit, dataSource, fillModel, dataFrom, dataTo, createdAt, finishedAt, summary, status, heartbeatAt, lastTickTs, stopReason, rehearsal`); `PgRunRepo(db, q?)` with `getRun`, `listOrders`, `listEquity(id, from, to)`, `listRunning`; `getRun` maps `SELECT * FROM runs WHERE id = $1` inline (no shared row mapper — Task 5 adds one).
- DB: `createPool(url, onError)`, `Queryable { query(text, values?) }`, `Db = pg.Pool`, `withTransaction`; migrations `0001`-`0005`; `migrate()` runs each file in its own transaction against the pool's `search_path` (tests use a throwaway schema `t_xxxx`).
- Compose Postgres: user `ctb`, password `ctb_local_only`, db `ctb`, host port 5433 (non-secret, local only). `.env.example` documents `DATABASE_URL`, `BLOCKFROST_PROJECT_ID`, `COLLECT_INTERVAL_SECONDS`, `COLLECT_VENUES`, `COLLECT_REFRESH`, `LOG_LEVEL`.
- Root: `tsconfig.json` `paths: { "@ctb/*": ["packages/*/src/index.ts"] }`, `include: packages/*/src, packages/*/test`; `vitest.config.ts` includes `packages/*/test/**/*.test.ts`; `eslint.config.js` flat config over everything but `node_modules`/`pgdata`; workspaces `packages/*`; scripts `test`, `test:pg` (`RUN_PG_TESTS=1`), `lint` (`eslint . && npm run typecheck`).
- uPlot 1.6.32 (MIT, © 2022 Leon Sorokin): `dist/uPlot.iife.min.js` 51,081 bytes sha256 `19c8d4c6ad88929a79f4ae49d6f7161566dfd0ba3d15cc495e974f787eb78f1f`; `dist/uPlot.min.css` 1,857 bytes sha256 `df630c6a8d6f8eeaff264b50f73ce5b114f646ffd9a0bb74f049b0a00135fa04`; `LICENSE` 1,078 bytes sha256 `8f989229699b4fe2f1a0432d0e9edc338a8a911e250e2d1b01ecd770a5f5b1bd`. Obtain with `npm pack uplot@1.6.32` and extract; never add it to `dependencies`.
- `doctor` (`commands/doctor.ts`) reads processes with `ps -axo pid=,command=` via `listProcesses()` and the digest via `loadDigestInput`.

## Global Constraints

- Everything in Plans 1-3's Global Constraints still binds (ESM, strict TS, no `any`, no empty catch without `// intentional:`, `console.*` only in `packages/cli`, parameterized SQL, `bigint` amounts, decimal-string prices, pg tests behind `RUN_PG_TESTS=1`, every new guard proven red by reinjection, one PR per task group off `main`, CI green before merge, every pg test drops nothing it did not create and runs inside `withTestSchema`).
- **The one rule (spec §4.1):** `packages/dashboard` defines no summarizer and no return, drawdown, fee, coverage or ADA arithmetic. Every number is the return value of a function imported from `@ctb/reports`. Task 5's guard test pins it.
- **Read only (spec §3):** every dashboard query goes through `DashboardReads` or an existing repo, connects as `ctb_dashboard`, and is `SELECT`/`WITH` only. Task 5's read-only guard pins it.
- **Localhost only:** the server listens on `127.0.0.1`; the bind address is not configurable.
- **Secrets never rendered:** no page reads `process.env` except through `loadConfig`; the health page shows the key by length via `checkEnv`. The smoke test asserts no body contains any value of a fake `.env`.
- **Synthetic data can never be mistaken for real:** a run with `rehearsal = true` renders the banner `REHEARSAL — synthetic data — not evidence` at the top of every page that shows it, and its row in `/runs` carries `REHEARSAL`.
- `@ctb/reports` imports only `@ctb/engine` types and nothing from `pg`, `@ctb/db`, `@ctb/cli`, `node:child_process`, `node:fs`. Task 1's guard pins it.
- Tables are rendered in the order the rows come from the query (newest first for runs); nothing is sorted by return.

---

### Task 1: Extract `@ctb/reports` (its own PR)

**Files:**
- Create: `packages/reports/package.json`, `packages/reports/src/index.ts`, `packages/reports/src/format.ts`, `packages/reports/src/summary.ts`, `packages/reports/src/digest.ts`, `packages/reports/src/doctor.ts`, `packages/reports/src/compare.ts`, `packages/reports/src/grid.ts`, `packages/reports/src/heartbeat.ts`, `packages/reports/test/purity.guard.test.ts`
- Modify: `packages/cli/package.json` (add `"@ctb/reports": "*"`), `packages/cli/src/config.ts`, `packages/cli/src/commands/report.ts`, `packages/cli/src/commands/status.ts`, `packages/cli/src/digest.ts`, `packages/cli/src/doctor.ts`, `packages/cli/src/compare.ts`, `packages/cli/src/grid.ts`, `packages/cli/src/commands/doctor.ts`, `packages/cli/src/commands/backtest.ts`
- Test: the existing cli tests must pass unchanged; `packages/reports/test/purity.guard.test.ts` is new.

**Interfaces:**
- Consumes: the functions listed in Facts.
- Produces (`@ctb/reports` index):
  - `format.ts`: `adaStr`, `coverageLine`, `feedCountersLine`, `resumesOf(run: Pick<RunRow,'params'>): string[]` (moved from `report.ts`, now exported).
  - `summary.ts`: `DaySummary`, `summarizeDay`, `summarizeRun`.
  - `digest.ts`: everything `packages/cli/src/digest.ts` exports today, unchanged.
  - `doctor.ts`: everything `packages/cli/src/doctor.ts` exports today, unchanged, plus `DEFAULT_COLLECT_INTERVAL_SEC = 600` now lives in `heartbeat.ts` and `doctor.ts` imports it from there.
  - `heartbeat.ts`: `DEFAULT_COLLECT_INTERVAL_SEC`, `DEFAULT_GRACE_SEC = 60`, `heartbeatAgeCell`, `isHeartbeatStale` (moved from `commands/status.ts`).
  - `compare.ts`: `CompareInput`, `CompareRow`, `compareRows`, `CompareRunInput`, `CompareRunRow`, `compareRunRows`, `SweepInput`, `SweepRow`, `sweepRows` (moved).
  - `grid.ts`: `gridCombinations`, `GridInput`, `GridRow`, `gridRows`, `gridWarning` (moved). `parseGridArg` STAYS in `packages/cli/src/grid.ts` (it is argument parsing).

- [ ] **Step 1: Create the package**

`packages/reports/package.json`:
```json
{
  "name": "@ctb/reports",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": { "@ctb/engine": "*" }
}
```
`packages/reports/src/index.ts`:
```ts
export { adaStr, coverageLine, feedCountersLine, resumesOf } from './format.js';
export { summarizeDay, summarizeRun, type DaySummary } from './summary.js';
export { BLOCKFROST_FREE_DAILY_QUOTA, MIN_PROJECTION_ELAPSED_SEC, QUOTA_OK_BELOW, digestLines, utcMidnight, type DigestInput } from './digest.js';
export { checkDigestLines, checkDisk, checkEnv, checkFakeRows, checkMigrations, checkNode, checkProcesses, LOW_DISK_BYTES, verdict, type Check, type ProcessLine, type Status } from './doctor.js';
export { DEFAULT_COLLECT_INTERVAL_SEC, DEFAULT_GRACE_SEC, heartbeatAgeCell, isHeartbeatStale } from './heartbeat.js';
export { compareRows, compareRunRows, sweepRows, type CompareInput, type CompareRow, type CompareRunInput, type CompareRunRow, type SweepInput, type SweepRow } from './compare.js';
export { gridCombinations, gridRows, gridWarning, type GridInput, type GridRow } from './grid.js';
```
Run `npm install --no-audit --no-fund` at the root so the workspace symlink exists.

- [ ] **Step 2: Move the code, file by file, with `git mv` where a whole file moves**

`git mv packages/cli/src/digest.ts packages/reports/src/digest.ts` (no import changes needed).
`git mv packages/cli/src/doctor.ts packages/reports/src/doctor.ts`; change its import to `import { DEFAULT_COLLECT_INTERVAL_SEC } from './heartbeat.js';`.
`packages/reports/src/heartbeat.ts`: the doc comments and bodies of `heartbeatAgeCell` and `isHeartbeatStale` from `commands/status.ts`, verbatim, plus:
```ts
/** The collector's default boundary; `status` and `paper` fall back to it for a run row that carries no interval of its own. */
export const DEFAULT_COLLECT_INTERVAL_SEC = 600;
export const DEFAULT_GRACE_SEC = 60;
```
`packages/reports/src/format.ts`: `adaStr`, `coverageLine`, `feedCountersLine`, `resumesOf` from `commands/report.ts`, verbatim with their doc comments; `resumesOf` becomes `export`.
`packages/reports/src/summary.ts`: `DaySummary`, `summarizeDay`, `summarizeRun` from `commands/report.ts`, verbatim.
`packages/reports/src/compare.ts`: all of `packages/cli/src/compare.ts` with imports `import { adaStr } from './format.js'; import { summarizeRun } from './summary.js'; import { heartbeatAgeCell } from './heartbeat.js';`.
`packages/reports/src/grid.ts`: `gridCombinations`, `GridInput`, `GridRow`, `gridRows`, `gridWarning` from `packages/cli/src/grid.ts` with `import { adaStr } from './format.js';`.

- [ ] **Step 3: Make the CLI files thin re-exports so every existing import path and test keeps working**

`packages/cli/src/digest.ts`: `export * from '@ctb/reports/src/digest.js';` is NOT allowed (deep import). Use the index:
```ts
export { BLOCKFROST_FREE_DAILY_QUOTA, MIN_PROJECTION_ELAPSED_SEC, QUOTA_OK_BELOW, digestLines, utcMidnight, type DigestInput } from '@ctb/reports';
```
`packages/cli/src/doctor.ts`:
```ts
export { checkDigestLines, checkDisk, checkEnv, checkFakeRows, checkMigrations, checkNode, checkProcesses, LOW_DISK_BYTES, verdict, type Check, type ProcessLine, type Status } from '@ctb/reports';
```
`packages/cli/src/compare.ts`:
```ts
export { compareRows, compareRunRows, sweepRows, type CompareInput, type CompareRow, type CompareRunInput, type CompareRunRow, type SweepInput, type SweepRow } from '@ctb/reports';
```
`packages/cli/src/grid.ts`: keep `parseGridArg` (and its doc comment) and add `export { gridCombinations, gridRows, gridWarning, type GridInput, type GridRow } from '@ctb/reports';`; delete the moved bodies and the `adaStr` import.
`packages/cli/src/config.ts`: delete the local `DEFAULT_COLLECT_INTERVAL_SEC` and add `export { DEFAULT_COLLECT_INTERVAL_SEC } from '@ctb/reports';` (keep the transform using it).
`packages/cli/src/commands/report.ts`: delete the moved bodies; add at the top
```ts
import { adaStr, coverageLine, feedCountersLine, resumesOf, summarizeDay, summarizeRun, type DaySummary } from '@ctb/reports';
export { adaStr, coverageLine, feedCountersLine, summarizeDay, summarizeRun, type DaySummary };
```
and remove the now-unused `RunCoverage` import if nothing else uses it.
`packages/cli/src/commands/status.ts`: delete `DEFAULT_INTERVAL_SEC`, `DEFAULT_GRACE_SEC`, `heartbeatAgeCell`, `isHeartbeatStale`; add `import { heartbeatAgeCell, isHeartbeatStale } from '@ctb/reports'; export { heartbeatAgeCell, isHeartbeatStale };` (paper.ts imports `isHeartbeatStale` from `./status.js` and stays unchanged).
`packages/cli/src/commands/doctor.ts` and `backtest.ts`: their imports of `../doctor.js`, `../compare.js`, `../grid.js`, `../digest.js` keep working through the re-exports; leave them.

- [ ] **Step 4: Write the purity guard**

`packages/reports/test/purity.guard.test.ts`:
```ts
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');
const FORBIDDEN = [/from '(pg|@ctb\/db|@ctb\/cli|@ctb\/collector|@ctb\/candles|node:child_process|node:fs|node:net|node:http)'/];

/** @ctb/reports is the set of functions two consumers (cli, dashboard) must agree on. It stays pure: no database, no process, no filesystem. */
describe('@ctb/reports purity', () => {
  it('imports nothing that reaches a database, a process or the filesystem', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(resolve(SRC, f), 'utf8');
      for (const re of FORBIDDEN) expect(text, `${f} matches ${re}`).not.toMatch(re);
    }
  });
});
```

- [ ] **Step 5: Run everything**

Run: `npm install --no-audit --no-fund && npm run lint && npm test && RUN_PG_TESTS=1 npx vitest run packages/cli/test/digest.pg.test.ts`
Expected: lint clean, every test that passed before still passes (count unchanged plus 1), pg digest test green.

- [ ] **Step 6: Prove the guard red**

Add `import { createPool } from '@ctb/db';` to `packages/reports/src/format.ts`, run `npx vitest run packages/reports`, expect the purity test to fail naming `format.ts`; remove the line; green again.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: extract @ctb/reports (format, summary, digest, doctor checks, heartbeat, compare, grid) from the CLI

The dashboard (M4) and the CLI must agree on every number; that is only certain if they
call the same functions. The CLI keeps its paths as re-exports so no test moved.
Purity guard: reports imports nothing that reaches a database, a process or the filesystem."
```

---

### Task 2: Digest input moves into `@ctb/collector`

**Files:**
- Modify: `packages/collector/src/repo.ts` (add `digestInput`), `packages/collector/src/index.ts`, `packages/cli/src/commands/status.ts` (delete `loadDigestInput`, call the repo), `packages/cli/src/commands/doctor.ts` (same), `packages/cli/test/digest.pg.test.ts` (import from collector)
- Test: `packages/cli/test/digest.pg.test.ts` moves to `packages/collector/test/digestInput.pg.test.ts` (`git mv`), importing `PgSnapshotRepo` and `type DigestInput` from `@ctb/reports`.

**Interfaces:**
- Produces: `PgSnapshotRepo.digestInput(intervalSec: number, venuesConfigured: string[], now: Date): Promise<DigestInput>` — the body of today's `loadDigestInput`, verbatim SQL, `this.db` instead of the `db` parameter. `@ctb/collector` gains `"@ctb/reports": "*"` in `package.json` for the `DigestInput` type.
- `packages/collector/src/index.ts` re-exports nothing new (the method is on the class).

- [ ] **Step 1: Move the function** as described; `status.ts` and `doctor.ts` call `new PgSnapshotRepo(db).digestInput(cfg.intervalSec, [...cfg.venues], now)`. Delete `loadDigestInput` and its export.
- [ ] **Step 2: Move the pg test** with `git mv`, fix imports (`../src/index.js` for `PgSnapshotRepo`, `../../db/test/helpers.js`), replace `loadDigestInput(db, 600, [...], now)` with `repo.digestInput(600, [...], now)`.
- [ ] **Step 3: Run** `npm run lint && npm test && RUN_PG_TESTS=1 npx vitest run packages/collector/test/digestInput.pg.test.ts` — green.
- [ ] **Step 4: Commit** `refactor(collector): digestInput on PgSnapshotRepo; the CLI no longer owns collector_runs SQL`.

---

### Task 3: Migration 0006 — the `ctb_dashboard` role (its own PR)

**Files:**
- Create: `packages/db/migrations/0006_dashboard_role.sql`, `packages/db/test/dashboardRole.pg.test.ts`
- Modify: `.env.example` (document `DASHBOARD_DATABASE_URL`), `packages/cli/src/config.ts` (`dashboardDatabaseUrl`)

**Interfaces:**
- Produces: role `ctb_dashboard`, password `ctb_dashboard_local_only` (local-only like `ctb_local_only`; the compose database is bound to localhost and this password is not a secret, exactly as `.env.example` says of the other one). `Config.dashboardDatabaseUrl: string`.

- [ ] **Step 1: Write the migration**

```sql
-- Read-only role for the dashboard (M4, spec §5). Cluster-wide, so created only once; every
-- grant is scoped to the CURRENT schema (search_path) so the throwaway test schemas and the real
-- one each get their own grants and DROP SCHEMA never trips over a role dependency. The password is
-- local-only in the same sense as ctb_local_only in docker-compose.yml: this database is bound to
-- 127.0.0.1 and holds no secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ctb_dashboard') THEN
    CREATE ROLE ctb_dashboard LOGIN PASSWORD 'ctb_dashboard_local_only';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ctb_dashboard', current_schema());
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO ctb_dashboard', current_schema());
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO ctb_dashboard', current_schema());
END $$;
```

- [ ] **Step 2: Write the behavioural test** (`packages/db/test/dashboardRole.pg.test.ts`), asserting what the role CAN and CANNOT do, never the catalog:

```ts
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/index.js';
import { PG_ENABLED, withTestSchema } from './helpers.js';

describe.skipIf(!PG_ENABLED)('ctb_dashboard role', () => {
  it('can SELECT from every table in the schema and cannot INSERT, UPDATE, DELETE or DDL', async () => {
    await withTestSchema(async (db) => {
      await migrate(db);
      const schema = (await db.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
      const url = new URL(process.env.DATABASE_URL ?? 'postgres://ctb:ctb_local_only@localhost:5433/ctb');
      url.username = 'ctb_dashboard'; url.password = 'ctb_dashboard_local_only';
      const ro = new pg.Pool({ connectionString: url.toString(), max: 1, options: `-c search_path=${schema}` });
      try {
        for (const t of ['tokens', 'collector_runs', 'pool_snapshots', 'candles', 'candles_external', 'external_pool_map', 'runs', 'paper_orders', 'run_equity', 'schema_migrations']) {
          await expect(ro.query(`SELECT count(*) FROM ${t}`), t).resolves.toBeDefined();
        }
        await expect(ro.query("INSERT INTO tokens VALUES ('u','p','a','A',0,'Meme','2026-09-05','t')")).rejects.toThrow(/permission denied/);
        await expect(ro.query('DELETE FROM runs')).rejects.toThrow(/permission denied/);
        await expect(ro.query('UPDATE runs SET status = $1', ['finished'])).rejects.toThrow(/permission denied/);
        await expect(ro.query('CREATE TABLE x (a int)')).rejects.toThrow(/permission denied/);
        // default privileges: a table created after the migration is readable too
        await db.query('CREATE TABLE later_table (a int)');
        await expect(ro.query('SELECT count(*) FROM later_table')).resolves.toBeDefined();
      } finally {
        await ro.end();
      }
    });
  });
});
```
Note the test relies on `withTestSchema`'s `DROP SCHEMA ... CASCADE`, which drops `later_table` and the schema-scoped default privileges with it; the role itself persists across tests by design.

- [ ] **Step 3: Config and env**

`.env.example` gains, after `DATABASE_URL`:
```
# Read-only connection for `npm run dashboard` (migration 0006 creates the role; the password is
# local-only like ctb_local_only). Leave unset to derive it from DATABASE_URL with that user.
DASHBOARD_DATABASE_URL=
```
`config.ts`: `DASHBOARD_DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional())`; `Config.dashboardDatabaseUrl` = the value, else `deriveDashboardUrl(databaseUrl)`:
```ts
/** DATABASE_URL with the read-only role's credentials; everything else (host, port, database) identical. */
export function deriveDashboardUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  u.username = 'ctb_dashboard';
  u.password = 'ctb_dashboard_local_only';
  return u.toString();
}
```
Test in `packages/cli/test/config.test.ts`: `deriveDashboardUrl('postgres://ctb:ctb_local_only@localhost:5433/ctb')` is `'postgres://ctb_dashboard:ctb_dashboard_local_only@localhost:5433/ctb'`; an explicit `DASHBOARD_DATABASE_URL` wins; a blank one derives.

- [ ] **Step 4: Run** `npm run lint && npm test && npm run test:pg` — green. Then apply to the dev database ONLY when the founder says so (it creates a cluster-wide role); the plan's acceptance runs `npm run migrate` in the main checkout at Task 6.
- [ ] **Step 5: Commit** `feat(db): migration 0006 ctb_dashboard SELECT-only role; DASHBOARD_DATABASE_URL`.

---

### Task 4: `@ctb/dashboard` package: server, HTML helpers, vendored uPlot, health page

**Files:**
- Create: `packages/dashboard/package.json`, `packages/dashboard/src/index.ts`, `packages/dashboard/src/html.ts`, `packages/dashboard/src/server.ts`, `packages/dashboard/src/pages/health.ts`, `packages/dashboard/vendor/uPlot.iife.min.js`, `packages/dashboard/vendor/uPlot.min.css`, `packages/dashboard/vendor/LICENSE.uplot`, `packages/dashboard/test/html.test.ts`, `packages/dashboard/test/health.test.ts`, `packages/dashboard/test/vendor.guard.test.ts`, `packages/dashboard/test/server.test.ts`
- Modify: `packages/cli/package.json` (`"@ctb/dashboard": "*"`), `packages/cli/src/commands/dashboard.ts` (new), `packages/cli/src/main.ts`, root `package.json` (`"dashboard": "tsx packages/cli/src/main.ts dashboard"`)

**Interfaces:**
- `packages/dashboard/package.json`: `{ "name": "@ctb/dashboard", "private": true, "type": "module", "exports": "./src/index.ts", "dependencies": { "@ctb/collector": "*", "@ctb/db": "*", "@ctb/engine": "*", "@ctb/reports": "*", "@ctb/universe": "*" } }`.
- `html.ts`:
```ts
export function escape(s: string | number | bigint | null | undefined): string;   // &, <, >, ", ' escaped; null/undefined -> ''
export function layout(title: string, body: string, opts?: { refreshSec?: number; rehearsal?: boolean }): string; // full document; <meta http-equiv="refresh"> when refreshSec; banner first when rehearsal
export function table(columns: string[], rows: Array<Array<string | number | bigint | null | undefined>>): string; // <table> with escaped cells; an empty rows array renders <p class="empty">none</p>
export function statusWord(word: 'OK' | 'WARN' | 'FAIL' | 'STALE' | 'WATCH' | 'STOP' | 'LOST'): string; // <span class="status status-ok">OK</span> etc. — the word IS the signal, colour is secondary
export const REHEARSAL_BANNER = 'REHEARSAL — synthetic data — not evidence';
```
- `server.ts`:
```ts
export interface DashboardDeps {
  reads: DashboardReads;              // Task 5; Task 4 stubs it with { listRuns: async () => [] } in tests
  runs: Pick<RunRepo, 'getRun' | 'listOrders' | 'listEquity'>;
  collector: { digestInput(intervalSec: number, venues: string[], now: Date): Promise<DigestInput> };
  processes: () => ProcessLine[];     // injected; the CLI passes `listProcesses` from commands/doctor.ts
  migrations: () => Promise<{ onDisk: string[]; applied: string[] }>;
  fakeRows: () => Promise<{ snapshots: number; candles: number }>;
  tickerOf: (unit: string) => string;
  intervalSec: number;
  venues: string[];
  now: () => Date;
  log: { info(o: object, m: string): void; error(o: object, m: string): void };
}
export function createDashboardServer(deps: DashboardDeps): http.Server;   // not yet listening
export function listen(server: http.Server, port: number): Promise<{ port: number; url: string }>; // binds 127.0.0.1 only; port 0 allowed (tests)
```
  Router: exact-match table `GET /`, `GET /runs`, `GET /runs/:id`, `GET /vendor/uPlot.iife.min.js`, `GET /vendor/uPlot.min.css`; anything else 404. Every handler is `async (req, url) => { status, body, contentType }`; the wrapper catches a throw, logs once (`error`), renders `errorPage(500, route, message)`. `HEAD` and any method other than `GET` answer 405.
- `pages/health.ts`: `renderHealth(input: { digest: string[]; checks: Check[]; now: Date }): string` — the digest lines as rows: the line's leading label (`collector`, `ticks last 24h`, `calls since 00:00 UTC`, `venues …`, `tokens …`, `last discovery`, `last 24h`) in the first cell, the rest in the second, and a `statusWord` derived exactly as `checkDigestLines` does (reuse it: `checkDigestLines(digest)` gives the words for the collector and quota rows; every other row shows no word). Then the `checks` table (`check`, `status`, `detail`) from `checkProcesses`, `checkMigrations`, `checkFakeRows`. `layout('Health', body, { refreshSec: 60 })`.

- [ ] **Step 1: Vendor uPlot**

```bash
cd "$(mktemp -d)" && npm pack uplot@1.6.32 --silent && tar -xzf uplot-1.6.32.tgz
cp package/dist/uPlot.iife.min.js ~/code/<worktree>/packages/dashboard/vendor/uPlot.iife.min.js
cp package/dist/uPlot.min.css     ~/code/<worktree>/packages/dashboard/vendor/uPlot.min.css
cp package/LICENSE                ~/code/<worktree>/packages/dashboard/vendor/LICENSE.uplot
```
`packages/dashboard/test/vendor.guard.test.ts` asserts the three files' byte sizes and sha256 equal the Facts values, and that `package.json` has no `uplot` dependency. Prove red by changing one byte of the CSS, restore.

- [ ] **Step 2: `html.ts` with tests** — `escape` on `<script>alert("x")</script>` → `&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;`; `table` escapes cells and renders `none` for no rows; `layout` puts the banner before everything when `rehearsal`, and a `<meta http-equiv="refresh" content="60">` when `refreshSec: 60` and none otherwise; `statusWord('STOP')` contains the word and the class.

- [ ] **Step 3: `server.ts`** with the router and the error wrapper; `listen` rejects if `host` is anything but `127.0.0.1` (it is hard-coded; the test only asserts `server.address().address === '127.0.0.1'`). Vendor routes read the two files from `packages/dashboard/vendor` with `Content-Type: text/javascript` / `text/css` and `Cache-Control: max-age=86400`.

- [ ] **Step 4: `pages/health.ts`** with `test/health.test.ts`: fixture digest lines (copy the ones in `digest.test.ts`) render seven rows, the quota row carries `OK`, a `STOP` line carries `STOP`, a LOST venues line renders with `LOST`; the checks table shows `FAIL` for two collectors; the document has the refresh meta; no `process.env` value appears (the page never sees env).

- [ ] **Step 5: CLI command**

`packages/cli/src/commands/dashboard.ts`:
```ts
export function parseDashboardArgs(args: string[]): { port: number } // --port N (1024..65535), default 3210; unknown flag refused
export async function dashboardCommand(log: Logger, args: string[]): Promise<void>
```
Builds the pool with `cfg.dashboardDatabaseUrl`, `deps` from the real repos (`PgRunRepo`, `PgSnapshotRepo`, `PgDashboardReads` from Task 5 — for Task 4 pass `{ listRuns: async () => [] }` and note it), `processes: listProcesses`, `migrations` via `listMigrations()` and `SELECT filename FROM schema_migrations`, `fakeRows` via the two counts `paper.ts` uses (export `fakeRowsPresent` from `paper.ts` is per-token; write a total variant `fakeRowsTotal(db)` next to it), `tickerOf` from `loadUniverse()`. Prints `dashboard: http://127.0.0.1:<port>/ (read-only, localhost only; Ctrl-C to stop)`. SIGINT/SIGTERM close the server and end the pool. `main.ts` gains `case 'dashboard': return dashboardCommand(log, rest);` and the usage string `dashboard [--port 3210]`.

- [ ] **Step 6: Server smoke test** (`test/server.test.ts`): `createDashboardServer` with fakes (`reads.listRuns` → two runs, `runs.getRun` → a paper run with equity, a backtest, a rehearsal run; `collector.digestInput` → a fixture `DigestInput`; `processes` → one collector; `migrations` → in sync; `fakeRows` → zeros), `listen(server, 0)`, then `fetch` `/`, `/runs`, `/runs/1`, `/runs/999`, `/runs/abc`, `/nope`, `/vendor/uPlot.min.css`, and `POST /` — assert 200/200/200/404/400/404/200/405 and `content-type` starts with `text/html` or `text/css`. Assert no body contains `SECRETVALUE` when the test sets `process.env.BLOCKFROST_PROJECT_ID = 'SECRETVALUE'` and `process.env.DATABASE_URL = 'postgres://u:SECRETPASS@h/d'` for the duration (restore after). Assert `server.address().address === '127.0.0.1'`.

- [ ] **Step 7: Run** `npm install --no-audit --no-fund && npm run lint && npm test` — green; then `npm run dashboard` in the worktree against the dev DB with `DASHBOARD_DATABASE_URL` unset (derived) — expect the health page at `http://127.0.0.1:3210/` (curl it; the role must exist: Task 3 applied to the dev DB first, founder's go).
- [ ] **Step 8: Commit** `feat(dashboard): package, server (127.0.0.1 only), html helpers, vendored uPlot 1.6.32, health page; npm run dashboard`.

---

### Task 5: Runs list, run detail, `DashboardReads`, the two guards (its own PR)

**Files:**
- Create: `packages/dashboard/src/reads.ts`, `packages/dashboard/src/pages/runs.ts`, `packages/dashboard/src/chart.ts`, `packages/dashboard/test/reads.pg.test.ts`, `packages/dashboard/test/runs.test.ts`, `packages/dashboard/test/chart.test.ts`, `packages/dashboard/test/readOnly.guard.test.ts`, `packages/dashboard/test/oneRule.guard.test.ts`
- Modify: `packages/engine/src/repo.ts` (export `rowToRun`), `packages/engine/src/index.ts`, `packages/dashboard/src/server.ts` (wire the pages), `packages/cli/src/commands/dashboard.ts` (real `PgDashboardReads`)

**Interfaces:**
- `@ctb/engine`: `export function rowToRun(r: RunsRowRaw): RunRow` — the mapping now inline in `getRun`, extracted; `getRun` calls it. `RunsRowRaw` is the inline row type, exported.
- `reads.ts`:
```ts
export interface RunFilter { mode?: 'backtest' | 'paper'; strategy?: string; unit?: string; status?: 'running' | 'finished' | 'aborted' }
export interface DashboardReads {
  /** Newest first. Always bounded. */
  listRuns(filter: RunFilter, limit: number, offset: number): Promise<RunRow[]>;
}
export class PgDashboardReads implements DashboardReads {
  constructor(private readonly q: Queryable) {}
  async listRuns(filter, limit, offset) {
    // WHERE clauses added only for present filter keys, all parameterized; ORDER BY id DESC LIMIT $n OFFSET $m; limit clamped to [1, 500]
  }
}
```
- `pages/runs.ts`:
```ts
export function renderRunsList(input: { runs: RunRow[]; tickerOf: (unit: string) => string; filter: RunFilter; page: number; pageSize: number; now: Date }): string;
export function renderRunDetail(input: { run: RunRow; ticker: string; orders: Array<OrderRecord & { baseUnit: string }>; equity: EquityPoint[]; now: Date }): string;
```
  List columns: `id` (link), `mode`, `strategy`, `ticker`, `status`, `created`, `return %`, `max DD %`, `fills / intents`, `warnings`, `rehearsal`. Return/DD/fills for a paper run from `summarizeRun(equity, orders)` — NO: the list must not load every run's rows. Rule: the list shows `runs.summary` numbers for every run with `basis = summary` in a tooltip-free extra column `basis`, exactly like `compareRunRows` does for backtests, and the detail page shows the persisted-rows headline for paper runs. Filters are a small form of four `<select>`s that GET the same URL. Rows with `rehearsal` show `REHEARSAL`; if any row is a rehearsal the banner is at the top.
  Detail: provenance table (`git sha`, `mode`, `source`, `window`, `fill model`, `params` as `<pre>` of `JSON.stringify(params, null, 2)` with `costs.venues` rendered as its own table `venue | batcher ADA | network ADA | basis | source`), then for paper runs the status lines (`status`, `heartbeat_at`, `last_tick_ts`, `stop_reason`, `resumes` via `resumesOf`, `feedCountersLine(params)`), `coverageLine(summary.coverage)`, every warning, the headline table from `summarizeRun(equity, orders)` for paper runs (columns as `printPersistedHeadline`), or from `run.summary` for backtests (columns as `printReport`), the reject reasons table, the equity chart (`chart.ts`) when `equity.length >= 2`, and the orders table with the CLI's columns, first 200 rows and a line `… N more orders`.
- `chart.ts`:
```ts
export function equitySeries(points: EquityPoint[]): { ts: number[]; equityAda: number[]; execAda: Array<number | null> }; // seconds since epoch; ADA as Number(adaStr(x)) — the ONLY place a lovelace becomes a float, for plotting only, and it goes through adaStr
export function chartHtml(id: string, series: ReturnType<typeof equitySeries>): string; // <div id> + <script> new uPlot({ width: 900, height: 300, series: [{}, { label: 'equity ADA' }, { label: 'executable ADA' }] }, data, el)
```
- The read-only guard (`test/readOnly.guard.test.ts`): a `Queryable` that records every SQL text and throws if it does not match `/^\s*(SELECT|WITH)\b/i`; run `PgDashboardReads.listRuns` with every filter combination and `PgRunRepo` (bound to the recorder) `getRun`, `listOrders`, `listEquity`; assert every recorded statement matched and none contained `INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE` even inside a string. Prove red by adding a `DELETE` statement to `listRuns` temporarily.
- The one-rule guard (`test/oneRule.guard.test.ts`): read every `.ts` under `packages/dashboard/src`; fail on any line matching `/(returnPct|maxDrawdownPct|feesLovelace|feesAda)\s*[:=]\s*(?!.*\b(summarizeRun|summarizeDay|compareRunRows|sweepRows|gridRows|adaStr)\b)/` (an assignment or object key computed locally), on `/ 1_000_000` or `/ 1e6` or `* 100` outside `chart.ts`, and on the words `function summarize` or `Summarizer`. Also assert the package's imports of `@ctb/reports` include `summarizeRun`, `adaStr`, `coverageLine`, `feedCountersLine`, `resumesOf`, `digestLines`, `checkDigestLines`. Prove red by adding `const returnPct = (end - start) / start * 100;` to `pages/runs.ts`, restore.
- `reads.pg.test.ts`: `withTestSchema`, `migrate`, insert a token and three runs via `PgRunRepo.createRun` (a paper rehearsal, a backtest, a finished paper), then `listRuns({}, 10, 0)` → ids newest first; `listRuns({ mode: 'paper' }, 10, 0)` → 2; `listRuns({ status: 'running' }, 10, 0)` → the running one; `listRuns({}, 1, 1)` → the middle one; `listRuns({}, 9999, 0)` → clamped to 500 (assert via the recorded SQL, or insert none and assert no throw).

- [ ] **Step 1: `rowToRun` in engine** (pure move; `getRun` unchanged in behaviour; run `packages/engine` tests).
- [ ] **Step 2: `reads.ts` + pg test** — green under `RUN_PG_TESTS=1`.
- [ ] **Step 3: `chart.ts` + test** — `equitySeries` of two points gives `ts` in seconds, `equityAda` via `adaStr`, `execAda` null where `equityExecutableLovelace` is null; `chartHtml` contains the div id and `new uPlot(`.
- [ ] **Step 4: `pages/runs.ts` + test** — fixtures: a paper run with 3 equity points and 2 orders renders the persisted-rows headline (`points 3`), the chart, the orders table and, when `rehearsal`, the banner; a backtest renders `equity is not persisted for backtest runs` and the summary headline; an unfinished run renders `unfinished`; a list with one rehearsal row has the banner and the word on that row; the filter form echoes the current filter as `selected`.
- [ ] **Step 5: Wire the router** — `/runs` parses `?mode=&strategy=&ticker=&status=&page=` (bad values → 400 naming the accepted ones; `page` ≥ 1), `pageSize = 50`; `/runs/:id` → 400 for a non-integer, 404 when `getRun` is null, else `Promise.all([listOrders, listEquity(id, new Date(0), now)])`. Extend `server.test.ts` accordingly (it already lists these routes).
- [ ] **Step 6: Both guards, proven red** as described, restored, green.
- [ ] **Step 7: Run** `npm run lint && npm test && npm run test:pg` — green. Then, in the worktree against the dev DB: `npm run dashboard`, `curl -s http://127.0.0.1:3210/runs | grep -c '<tr'` ≥ 10; `curl -s http://127.0.0.1:3210/runs/7` contains `REHEARSAL` (run 7 is a rehearsal) and `points`; `curl -s http://127.0.0.1:3210/runs/82` contains `rsi-mean-reversion` and `equity is not persisted`.
- [ ] **Step 8: Commit** `feat(dashboard): runs list with filters, run detail with persisted-rows headline and equity chart; DashboardReads; read-only and one-rule guards`.

---

### Task 6: Acceptance and docs (its own PR)

**Files:**
- Create: `docs/ops/RUNBOOK-dashboard.md`
- Modify: `README.md` (Quick start: `npm run dashboard`), `docs/ops/RUNBOOK-collector.md` and `RUNBOOK-paper.md` (one line each: the health page is the morning check), `packages/cli/src/commands/doctor.ts` (informational check: `dashboard` → whether `http://127.0.0.1:3210/` answers, via `fetch` with a 1 s timeout; `ok` either way, detail `running` / `not running`)

- [ ] **Step 1:** With the founder's go, `npm run migrate` in the main checkout (applies 0006 to the dev database, creating the role), then `npm run dashboard` there; open `/`, `/runs`, `/runs/<a paper run>` in the browser; screenshot nothing into the repo, but record in the runbook the three URLs and what each shows.
- [ ] **Step 2:** `docs/ops/RUNBOOK-dashboard.md`: start (`npm run dashboard [--port]`), what it can never do (no writes, no remote), the role and how to verify it (`psql` as `ctb_dashboard` fails on `DELETE`), stop (Ctrl-C), and "if the health page and `status --digest` ever disagree, that is a bug in the one rule: file it".
- [ ] **Step 3:** Commit `docs(ops): dashboard runbook; doctor reports whether the dashboard is up`.

M4a is done when: `npm run dashboard` serves `/`, `/runs`, `/runs/:id` from the read-only role; the smoke, read-only and one-rule guards are green in CI; the founder has used the health page as the morning check once and it matched `status --digest`.

## Self-review

- Spec coverage: §3 boundaries → Global Constraints + Tasks 3-5 guards; §4 package layout → Task 4/5 files (`universe.ts`, `compare.ts` pages are M4b/M4c, not here); §4.1 → Task 1 extraction + Task 5 one-rule guard; §4.2 `/`, `/runs`, `/runs/:id` → Tasks 4-5; §4.3 `listRuns` → Task 5 (the other reads are M4b/c); §5 role → Task 3; §6 errors → Task 4 wrapper + Task 5 400/404; §7 tests → Tasks 1, 3, 4, 5; §8 M4a → Task 6.
- Placeholders: none; every step has its code or its exact command.
- Type consistency: `DigestInput`/`ProcessLine`/`Check` come from `@ctb/reports` everywhere; `DashboardDeps.collector.digestInput` matches Task 2's method; `RunFilter` keys match the query parameters in Task 5 Step 5; `rowToRun` is introduced in Task 5 Step 1 before `reads.ts` uses it.
