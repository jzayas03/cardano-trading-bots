# Paper-Trading Foundation, Plan 3 of 3 (M3: verified costs, incremental persistence, paper mode, rehearsal, 7-day run)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `paper` command that runs a strategy against live 5-minute candles as they land, persists every order and every equity point as it happens, survives a restart, refuses to trade on stale data, and produces a daily report citing run id, git sha, fills, and costs — plus a rehearsal path that exercises the whole loop end to end before a Blockfrost key exists.

**Architecture:** No new package. `@ctb/sim-executor` gets verified per-venue costs with provenance, mark-to-market, and intra-candle reserve depletion. `@ctb/engine` gets persistence sinks, bounded memory, an abort signal, and resume (`startSeq`). Migration 0004 adds `run_equity` and run status/heartbeat columns. The CLI gets `paper`, `report --day`, a `status` section for running paper runs, and a dev-only `dev:fake-collector` that writes synthetic snapshots so the loop can be rehearsed locally. The 7-day run is a runbook, not code.

**Tech Stack:** unchanged (Node 24, TypeScript strict, tsx, Vitest, pg, zod, pino). No new dependencies.

**Spec:** `docs/specs/2026-09-05-paper-trading-foundation.md` (§4.4 paper clock, §4.5, §4.6 `paper`/`report`, §6 stale pair refuses to trade, §7, §8 M3)

**Plans 1 and 2:** `docs/plans/2026-09-05-m0-m1-collector.md`, `docs/plans/2026-09-06-m2-candles-engine.md` (both merged). M2 acceptance: `docs/ops/2026-09-06-m2-report.md`.

## Facts verified on 2026-09-06 (do not re-derive; read from `main` at ab75a2e)

- Engine: `runEngine(deps: RunEngineDeps)` with `feed`, `strategy`, `params?`, `executor`, `initial`, `decimals`, `log`, `historyLimit?`, `intervalSec?`, `maxGapMs?`; `Strategy` has `warmupFor(params)`; `RunSummaryStats` has `coverage: RunCoverage` and `warnings: string[]`; `EquityPoint { tickTs, cashLovelace, positionBase, equityLovelace, price }`; `FillResult` filled carries `slippageBps` and `priceImpactBps`; `RunRepo` has `createRun`, `finishRun`, `getRun`, `insertOrders`, `listOrders`; `NewRun.mode` is `'backtest' | 'paper'`; `gitShaOrUnknown(cwd)`.
- Executor: `SimExecutor({ decimals, baseUnit, fillModel, maxGapMs, costOverrides? })`; `FillModel = { kind: 'cpmm_observed' } | { kind: 'cpmm_synthetic_depth'; depthLovelace }`; costs: `VenueCosts { batcherFeeLovelace, networkFeeLovelace }`, `DEFAULT_COSTS`, `VENUE_COSTS`, `costsForPoolId`, `tryCostsForPoolId`, `venueOf`. Stale fills reject with `stale t+1 (gap Nm)`.
- Candles: `PgCandleRepo` with `transaction`, `buildCandlesForToken(repo, token)` incremental and transactional; `decimalToScaled`, `formatScaled`, `PRICE_SCALE`.
- DB: `withTransaction(db, fn)`, `Queryable`; migrations 0001-0003; `runs` has `mode, strategy_id, params, git_sha, base_unit, data_source, fill_model, data_from, data_to, created_at, finished_at, summary`; `paper_orders` PK `(run_id, seq)` with `price_impact_bps`.
- CLI: `main.ts` switch; `ensureTokens(db, universe)`; `feeds.ts` (`localCandleFeed`, `externalCandleFeed`); `backtest.ts` (`parseBacktestArgs`, `buildRunParams(strategyDefaults, argParams, cashAda, depthAda, costOverrides, maxGapMs)`, `DEFAULT_MAX_GAP_MIN = 15`); `report.ts` (`adaStr`, `coverageLine`, `printReport`); `schedule.ts` (`msUntilNextBoundary`, `sleep(ms, signal)`); `collect.ts` loop shape (boundary sleep, SIGINT/SIGTERM once, `db.end()` in finally).
- Per-venue fees read from each venue's own docs on 2026-09-06 (M2 report §1): Minswap v1 batcher fee removed May 2025 (0 ADA); SundaeSwap v1 2.5 ADA (scooper); SundaeSwap v3 dynamic 0.5-1.0 ADA (use 1.0, the conservative end); MuesliSwap 0.95 ADA; MinswapV2 conflicting first-party sources; WingRiders, WingRidersV2, VyFinance, Splash not stated. Network fee 0.2 ADA remains an estimate for all.
- Postgres bind-parameter limit is 65535 per statement; all bulk inserts are chunked at `INSERT_CHUNK_ROWS = 1000`.
- The observed-fill path (`cpmm_observed`, `candles`, deepest pool, net flows) has never executed against real snapshots. It first will in this plan, either through the rehearsal tool (synthetic) or after M1 (real).

## Global Constraints

- Everything in Plans 1 and 2's Global Constraints still binds (ESM, strict TS, no `any`, no empty catch without `// intentional:`, `console.*` only in `packages/cli`, parameterized SQL, `bigint` amounts, decimal-string prices, pg tests behind `RUN_PG_TESTS=1`, every new guard proven red by reinjection, one PR per group off `main`, CI green before merge).
- **Paper mode never fills at `t`, never fills across a gap wider than `maxGapMs`, and never fills a candle whose `tickTs` is older than `maxGapMs` when it arrives.** Spec §6: a stale pair does not trade.
- **Every order and every equity point is persisted before the loop moves to the next candle.** A crash loses at most the in-flight intents of one candle, and those are recorded as rejected `stopped` on resume.
- **Synthetic data can never be mistaken for real.** The fake collector refuses to run unless `CTB_ALLOW_FAKE_DATA=1` and the database host is `localhost`; every run started against it carries `runs.rehearsal = true`, and every report header of such a run begins with `REHEARSAL`.
- A `VenueCosts` entry that is not documented is `basis: 'assumed'`, and a report names every assumed venue a fill touched.
- The paper process builds candles itself each boundary; it does not depend on a separate `candles` cron. The collector (`collect`) is a separate process and must be running for real candles to exist.

---

### Task 1: Verified per-venue costs with provenance (its own PR)

**Files:**
- Modify: `packages/sim-executor/src/costs.ts`, `packages/sim-executor/test/simExecutor.test.ts` (costs section), `packages/cli/src/commands/backtest.ts` (`buildRunParams` records `basis`), `packages/cli/src/commands/report.ts` (assumed-venue warning)
- Create: `packages/sim-executor/test/costs.test.ts`, `packages/sim-executor/test/costsProvenance.guard.test.ts`

**Interfaces:**
- Produces:
  - `interface VenueCosts { batcherFeeLovelace: bigint; networkFeeLovelace: bigint; basis: 'documented' | 'assumed'; source: string; readAt: string }`
  - `VENUE_COSTS` values (table below); `DEFAULT_COSTS` becomes the `assumed` placeholder `{ 2_000_000n, 200_000n, 'assumed', 'plan-2 assumption', '2026-09-06' }`.
  - `costsForPoolId(poolId, overrides?)` unchanged signature; an override sets `basis: 'assumed'` and `source: 'cli override'` for the overridden fields' venue.
  - `assumedVenuesTouched(orders: Array<{ result: FillResult }>): string[]` exported from `@ctb/sim-executor` (distinct venue names of filled orders whose `VENUE_COSTS[venue].basis === 'assumed'`).

| Venue | batcher lovelace | basis | source | readAt |
| --- | --- | --- | --- | --- |
| Minswap | `0n` | documented | `https://docs.minswap.org/courses/how-to-perform-swaps/batcher` | 2026-09-06 |
| MinswapV2 | `2_000_000n` | assumed | `https://docs.minswap.org/courses/how-to-perform-swaps/batcher (conflicts with the v2 spec on GitHub)` | 2026-09-06 |
| SundaeSwapV1 | `2_500_000n` | documented | `SundaeV3.pdf §3` | 2026-09-06 |
| SundaeSwapV3 | `1_000_000n` | documented | `SundaeV3.pdf §4.4.3 (dynamic 0.5-1.0; upper bound used)` | 2026-09-06 |
| MuesliSwap | `950_000n` | documented | `https://docs.muesliswap.com` | 2026-09-06 |
| WingRiders | `2_000_000n` | assumed | `https://docs.wingriders.com (amount not stated)` | 2026-09-06 |
| WingRidersV2 | `2_000_000n` | assumed | same | 2026-09-06 |
| VyFinance | `2_000_000n` | assumed | `https://docs.vyfi.io (amount not stated)` | 2026-09-06 |
| Splash | `2_000_000n` | assumed | `https://docs.splash.trade (amount not stated)` | 2026-09-06 |

Network fee: `200_000n` for every venue, `basis` follows the venue row (a documented batcher fee with an estimated network fee is still `documented` for the batcher; keep one `basis` per row and note in the header comment that the network fee is an estimate everywhere).

- [ ] **Step 1: Branch**

```bash
cd ~/code/cardano-trading-bots && git fetch origin && git checkout -b feat/m3-costs origin/main
```

- [ ] **Step 2: Failing tests**

`packages/sim-executor/test/costs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FillResult } from '@ctb/engine';
import { assumedVenuesTouched, costsForPoolId, VENUE_COSTS } from '../src/index.js';

describe('VENUE_COSTS (read from venue docs 2026-09-06, see M2 report §1)', () => {
  it('carries the documented values', () => {
    expect(costsForPoolId('Minswap:x').batcherFeeLovelace).toBe(0n);
    expect(costsForPoolId('SundaeSwapV1:x').batcherFeeLovelace).toBe(2_500_000n);
    expect(costsForPoolId('SundaeSwapV3:x').batcherFeeLovelace).toBe(1_000_000n);
    expect(costsForPoolId('MuesliSwap:x').batcherFeeLovelace).toBe(950_000n);
    expect(costsForPoolId('Minswap:x').basis).toBe('documented');
  });
  it('marks the unverified venues as assumed at 2 ADA', () => {
    for (const v of ['MinswapV2', 'WingRiders', 'WingRidersV2', 'VyFinance', 'Splash']) {
      const c = costsForPoolId(`${v}:x`);
      expect(c.batcherFeeLovelace).toBe(2_000_000n);
      expect(c.basis).toBe('assumed');
    }
  });
  it('an override becomes assumed with a cli source', () => {
    const c = costsForPoolId('Minswap:x', { batcherFeeLovelace: 1_500_000n });
    expect(c).toMatchObject({ batcherFeeLovelace: 1_500_000n, basis: 'assumed', source: 'cli override' });
  });
  it('assumedVenuesTouched lists distinct assumed venues of filled orders only', () => {
    const filled = (poolId: string): { result: FillResult } => ({ result: { status: 'filled', poolId, unitIn: 'lovelace', amountIn: 1n, unitOut: 'x', amountOut: 1n,
      midPrice: '1', fillPrice: '1', poolFeeIn: 0n, batcherFeeLovelace: 0n, networkFeeLovelace: 0n, slippageBps: 0, priceImpactBps: 0, tsFill: new Date(0) } });
    const rejected = { result: { status: 'rejected' as const, reason: 'dust' } };
    expect(assumedVenuesTouched([filled('Splash:a'), filled('Splash:b'), filled('Minswap:c'), rejected, filled('VyFinance:d')])).toEqual(['Splash', 'VyFinance']);
  });
});
```

`packages/sim-executor/test/costsProvenance.guard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VENUE_NAMES } from '@ctb/collector';
import { VENUE_COSTS } from '../src/index.js';

/** A cost without a source and a date is a guess that will be read as a fact. */
describe('every venue cost carries provenance', () => {
  it('has a non-empty source, an ISO date, and a basis for every venue', () => {
    for (const v of VENUE_NAMES) {
      const c = VENUE_COSTS[v];
      expect(c.source.length, v).toBeGreaterThan(8);
      expect(c.readAt, v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['documented', 'assumed']).toContain(c.basis);
      if (c.basis === 'documented') expect(c.source, v).toMatch(/^https?:\/\/|\.pdf/);
    }
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run packages/sim-executor` → the new tests FAIL (`basis` undefined, wrong values).

- [ ] **Step 4: Implement**

`packages/sim-executor/src/costs.ts` (replace the file):
```ts
import { isDexName, type DexName } from '@ctb/collector';
import type { FillResult } from '@ctb/engine';

/**
 * Per-venue fixed costs of one swap, with provenance. Batcher/agent/scooper fees were read from each
 * venue's own documentation on 2026-09-06 (docs/ops/2026-09-06-m2-report.md §1). A venue whose docs do
 * not state a number is `assumed` at 2 ADA and is named in every report it touches. The network fee is an
 * estimate (0.2 ADA) everywhere; `basis` describes the batcher fee. Lowering a fee makes reported results
 * better, which is exactly why a value with no source is not allowed here (costsProvenance.guard).
 */
export interface VenueCosts {
  batcherFeeLovelace: bigint;
  networkFeeLovelace: bigint;
  basis: 'documented' | 'assumed';
  source: string;
  readAt: string;
}

const NETWORK = 200_000n;
const READ_AT = '2026-09-06';
const MINSWAP_DOC = 'https://docs.minswap.org/courses/how-to-perform-swaps/batcher';

export const DEFAULT_COSTS: VenueCosts = { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'plan-2 assumption', readAt: READ_AT };

export const VENUE_COSTS: Record<DexName, VenueCosts> = {
  Minswap: { batcherFeeLovelace: 0n, networkFeeLovelace: NETWORK, basis: 'documented', source: MINSWAP_DOC, readAt: READ_AT },
  MinswapV2: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: `${MINSWAP_DOC} (conflicts with the v2 spec on GitHub; on-chain check pending)`, readAt: READ_AT },
  SundaeSwapV1: { batcherFeeLovelace: 2_500_000n, networkFeeLovelace: NETWORK, basis: 'documented', source: 'SundaeV3.pdf §3 (scooper fee)', readAt: READ_AT },
  SundaeSwapV3: { batcherFeeLovelace: 1_000_000n, networkFeeLovelace: NETWORK, basis: 'documented', source: 'SundaeV3.pdf §4.4.3 (dynamic 0.5-1.0 ADA; upper bound used)', readAt: READ_AT },
  MuesliSwap: { batcherFeeLovelace: 950_000n, networkFeeLovelace: NETWORK, basis: 'documented', source: 'https://docs.muesliswap.com', readAt: READ_AT },
  WingRiders: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'https://docs.wingriders.com (amount not stated)', readAt: READ_AT },
  WingRidersV2: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'https://docs.wingriders.com (amount not stated)', readAt: READ_AT },
  VyFinance: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'https://docs.vyfi.io (amount not stated)', readAt: READ_AT },
  Splash: { batcherFeeLovelace: 2_000_000n, networkFeeLovelace: NETWORK, basis: 'assumed', source: 'https://docs.splash.trade (amount not stated)', readAt: READ_AT },
};

export function venueOf(poolId: string): string {
  return poolId.split(':')[0] ?? '';
}

export function tryCostsForPoolId(poolId: string, overrides?: Partial<Pick<VenueCosts, 'batcherFeeLovelace' | 'networkFeeLovelace'>>): VenueCosts | null {
  const venue = venueOf(poolId);
  if (!isDexName(venue)) return null;
  const base = VENUE_COSTS[venue];
  if (!overrides || (overrides.batcherFeeLovelace === undefined && overrides.networkFeeLovelace === undefined)) return base;
  return { ...base, ...overrides, basis: 'assumed', source: 'cli override', readAt: READ_AT };
}

export function costsForPoolId(poolId: string, overrides?: Partial<Pick<VenueCosts, 'batcherFeeLovelace' | 'networkFeeLovelace'>>): VenueCosts {
  const c = tryCostsForPoolId(poolId, overrides);
  if (!c) throw new Error(`unknown venue in pool id ${poolId}`);
  return c;
}

/** Distinct venues with `basis: 'assumed'` among FILLED orders, sorted; the report names them. */
export function assumedVenuesTouched(orders: Array<{ result: FillResult }>): string[] {
  const out = new Set<string>();
  for (const o of orders) {
    if (o.result.status !== 'filled') continue;
    const v = venueOf(o.result.poolId);
    if (isDexName(v) && VENUE_COSTS[v].basis === 'assumed') out.add(v);
  }
  return [...out].sort();
}
```
Keep the existing `costOverrides?: Partial<VenueCosts>` option on `SimExecutor` but narrow its type to `Partial<Pick<VenueCosts, 'batcherFeeLovelace' | 'networkFeeLovelace'>>`; adjust callers (`backtest.ts`).

In `backtest.ts` `buildRunParams`, the recorded `venues` map now includes `basis`, `source`, `readAt` per venue (strings), so a run row shows which fees were documented at run time. In `report.ts` `printReport`, after the summary table print: `const assumed = assumedVenuesTouched(orders); if (assumed.length) console.log(`warning: fills touched venues with ASSUMED costs: ${assumed.join(', ')} (see runs.params.costs.venues)`);`.

Update `packages/sim-executor/test/simExecutor.test.ts`'s `costsForPoolId` expectations: `MinswapV2:abc` → `toMatchObject({ batcherFeeLovelace: 2_000_000n, basis: 'assumed' })`; the `Splash` override case → `basis: 'assumed', source: 'cli override'`; any test that asserted `batcherFeeLovelace: 2_000_000n` on a `SundaeSwapV3` fixture must now expect `1_000_000n` (and the buy test's `insufficient cash` fixture threshold changes with it: cash `1_001_000_000n` vs `1_000_000_000n + 1_200_000n` still rejects; keep).

- [ ] **Step 5: Prove the provenance guard red**

Temporarily set `Splash.source` to `''` → guard FAILS; restore. Temporarily set `Minswap.basis` to `'documented'` with `source: 'n/a'` → guard FAILS (documented needs a URL or pdf); restore. Paste both.

- [ ] **Step 6: Tests, lint, commit, PR, merge**

```bash
npx vitest run packages/sim-executor packages/cli && npm test && npm run lint
git add -A && git commit -m "feat(sim-executor): per-venue costs read from venue docs, with basis/source/readAt provenance; reports name assumed venues

Minswap v1 0 ADA (fee removed May 2025), SundaeSwap v1 2.5, v3 1.0 (upper bound of 0.5-1.0), MuesliSwap 0.95;
MinswapV2, WingRiders v1/v2, VyFinance, Splash remain assumed at 2 ADA. Guard proven red two ways.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Open PR `feat/m3-costs` → main titled "costs: per-venue fees with provenance"; this PR changes reported numbers and is reviewed by the founder alone. Merge only after that review.

---

### Task 2: Migration 0004 and run-repository extensions (equity, status, heartbeat, resume)

**Files:**
- Create: `packages/db/migrations/0004_paper_mode.sql`, `packages/db/test/paperSchema.pg.test.ts`
- Modify: `packages/engine/src/repo.ts`, `packages/engine/src/index.ts`, `packages/engine/test/repo.pg.test.ts`

**Interfaces:**
- Produces (schema):
  - `run_equity (run_id bigint FK runs, tick_ts timestamptz, cash_lovelace numeric(38,0), position_base numeric(38,0), equity_lovelace numeric(38,0), equity_executable_lovelace numeric(38,0) NULL, price numeric(38,18), PRIMARY KEY (run_id, tick_ts))`
  - `runs` new columns: `status text NOT NULL DEFAULT 'finished' CHECK (status IN ('running','finished','aborted'))`, `heartbeat_at timestamptz`, `last_tick_ts timestamptz`, `stop_reason text`, `rehearsal boolean NOT NULL DEFAULT false`. Existing rows (all finished backtests) keep `finished`.
- Produces (repo): `RunRepo` gains
  - `insertEquity(runId: number, points: EquityPoint[]): Promise<number>` (chunked; `ON CONFLICT (run_id, tick_ts) DO NOTHING`)
  - `lastEquity(runId: number): Promise<EquityPoint | null>`
  - `listEquity(runId: number, from: Date, to: Date): Promise<EquityPoint[]>`
  - `lastOrderSeq(runId: number): Promise<number>` (0 when none)
  - `listOrdersBetween(runId: number, from: Date, to: Date): Promise<Array<OrderRecord & { baseUnit: string }>>` (by `ts_intent`)
  - `heartbeat(runId: number, at: Date, lastTickTs: Date | null): Promise<void>`
  - `setStatus(runId: number, status: 'running' | 'finished' | 'aborted', reason: string | null): Promise<void>`
  - `listRunning(): Promise<Array<{ id: number; strategyId: string; baseUnit: string; rehearsal: boolean; heartbeatAt: Date | null; lastTickTs: Date | null; createdAt: Date }>>`
  - `createRun(r: NewRun & { rehearsal?: boolean; status?: 'running' | 'finished' })` (backtests keep the default `finished` written at `finishRun`; paper passes `status: 'running'`)
  - `RunRow` gains `status`, `heartbeatAt`, `lastTickTs`, `stopReason`, `rehearsal`.
  - `EquityPoint` gains `equityExecutableLovelace: bigint | null` (defined in Task 3's types change; this task's repo maps the column and Task 3 fills it; order the PRs so Task 3's type lands with this task in the same PR group).

- [ ] **Step 1: Branch** `git checkout -b feat/m3-persistence origin/main` (after the costs PR merged).

- [ ] **Step 2: Failing pg tests**

`packages/db/test/paperSchema.pg.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { PG_ENABLED, withTestSchema } from './helpers.js';

const SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b';

describe.skipIf(!PG_ENABLED)('0004_paper_mode', () => {
  it('adds run_equity and the run status columns; existing runs read as finished', async () => {
    await withTestSchema(async (db) => {
      // apply 0001-0003, insert a legacy run, then 0004 on top of it
      const all = await migrate(db);
      expect(all).toContain('0004_paper_mode.sql');
      await db.query(`INSERT INTO tokens VALUES ($1, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [SNEK]);
      const r = await db.query<{ id: string; status: string; rehearsal: boolean }>(
        `INSERT INTO runs (mode, strategy_id, git_sha, base_unit, data_source, fill_model, data_from, data_to)
         VALUES ('backtest', 'x', 'sha', $1, 'candles', 'cpmm_observed', now(), now()) RETURNING id, status, rehearsal`, [SNEK]);
      expect(r.rows[0]).toMatchObject({ status: 'finished', rehearsal: false });
      await expect(db.query(`UPDATE runs SET status = 'paused' WHERE id = $1`, [r.rows[0]?.id])).rejects.toThrow(/runs_status_check/);
      await db.query(`INSERT INTO run_equity (run_id, tick_ts, cash_lovelace, position_base, equity_lovelace, price) VALUES ($1, now(), 1, 0, 1, 0.5)`, [r.rows[0]?.id]);
      await expect(db.query(`INSERT INTO run_equity (run_id, tick_ts, cash_lovelace, position_base, equity_lovelace, price) VALUES ($1, now() - interval '1 minute', -1, 0, 1, 0.5)`, [r.rows[0]?.id]))
        .rejects.toThrow(/run_equity_cash_lovelace_check/);
    });
  });
});
```

Extend `packages/engine/test/repo.pg.test.ts` with a second `it`: create a paper run with `status: 'running'`, `rehearsal: true`; `insertEquity` three points (the middle one with `equityExecutableLovelace: null`); `lastEquity` returns the third with bigint fields; `listEquity` over a window returns two; `insertOrders` two orders then `lastOrderSeq` → 2; `listOrdersBetween` filters by `ts_intent`; `heartbeat` then `getRun().heartbeatAt/lastTickTs` set; `setStatus('aborted', 'boom')` then `getRun()` shows `status: 'aborted', stopReason: 'boom'`; `listRunning()` no longer includes it.

- [ ] **Step 3: Migration**

`packages/db/migrations/0004_paper_mode.sql`:
```sql
-- Paper mode (Plan 3). A 7-day run cannot hold its equity curve in memory and write it at the end
-- (final review I6): every point is persisted as it happens, and the run row carries liveness.
CREATE TABLE IF NOT EXISTS run_equity (
  run_id                     bigint NOT NULL REFERENCES runs(id),
  tick_ts                    timestamptz NOT NULL,
  cash_lovelace              numeric(38,0) NOT NULL CHECK (cash_lovelace >= 0),
  position_base              numeric(38,0) NOT NULL CHECK (position_base >= 0),
  equity_lovelace            numeric(38,0) NOT NULL,
  -- what the position would fetch if sold now, net of fees; null when the executor cannot price it
  equity_executable_lovelace numeric(38,0),
  price                      numeric(38,18) NOT NULL CHECK (price > 0),
  PRIMARY KEY (run_id, tick_ts)
);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'finished';
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN ('running', 'finished', 'aborted'));
ALTER TABLE runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS last_tick_ts timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS stop_reason text;
-- true when the run consumed synthetic snapshots from dev:fake-collector; such a run is never evidence
ALTER TABLE runs ADD COLUMN IF NOT EXISTS rehearsal boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS runs_running ON runs (status) WHERE status = 'running';
```

- [ ] **Step 4: Repository**

Add to `packages/engine/src/repo.ts` (inside `PgRunRepo`, plus the interface additions above). Key SQL:
```ts
const EQUITY_PARAMS = 7;
async insertEquity(runId: number, points: EquityPoint[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < points.length; i += INSERT_CHUNK_ROWS) {
    const chunk = points.slice(i, i + INSERT_CHUNK_ROWS);
    const values: unknown[] = [];
    const tuples = chunk.map((p, j) => {
      values.push(runId, p.tickTs, p.cashLovelace.toString(), p.positionBase.toString(), p.equityLovelace.toString(),
        p.equityExecutableLovelace === null ? null : p.equityExecutableLovelace.toString(), p.price);
      return `(${Array.from({ length: EQUITY_PARAMS }, (_, k) => `$${j * EQUITY_PARAMS + k + 1}`).join(', ')})`;
    });
    const r = await this.db.query(
      `INSERT INTO run_equity (run_id, tick_ts, cash_lovelace, position_base, equity_lovelace, equity_executable_lovelace, price)
       VALUES ${tuples.join(', ')} ON CONFLICT (run_id, tick_ts) DO NOTHING`, values);
    n += r.rowCount ?? 0;
  }
  return n;
}
```
(`INSERT_CHUNK_ROWS` is exported by `@ctb/candles`; import it, do not redefine.) `lastEquity`: `SELECT ... ORDER BY tick_ts DESC LIMIT 1`; `listEquity`: `BETWEEN $2 AND $3 ORDER BY tick_ts`; `lastOrderSeq`: `SELECT coalesce(max(seq), 0) AS seq FROM paper_orders WHERE run_id = $1`; `listOrdersBetween`: the existing `listOrders` query with `AND ts_intent BETWEEN $2 AND $3`; `heartbeat`: `UPDATE runs SET heartbeat_at = $2, last_tick_ts = coalesce($3, last_tick_ts) WHERE id = $1`; `setStatus`: `UPDATE runs SET status = $2, stop_reason = $3, finished_at = CASE WHEN $2 = 'running' THEN NULL ELSE coalesce(finished_at, now()) END WHERE id = $1`; `listRunning`: `SELECT id, strategy_id, base_unit, rehearsal, heartbeat_at, last_tick_ts, created_at FROM runs WHERE status = 'running' ORDER BY id`; `createRun` gains `status`/`rehearsal` columns in its INSERT with defaults `'finished'`/`false`; `getRun` maps the five new columns. Refactor `listOrders` and `listOrdersBetween` to share one row mapper.

- [ ] **Step 5: Tests, lint, commit**

```bash
npm run test:pg -- packages/db packages/engine && npm test && npm run lint
git add -A && git commit -m "feat(db,engine): migration 0004 (run_equity, run status/heartbeat/rehearsal) and run-repo methods for incremental persistence and resume

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Engine — persistence sinks, bounded memory, abort, resume; executor — mark-to-market, reserve depletion, worst-of synthetic pricing

**Files:**
- Modify: `packages/engine/src/types.ts`, `packages/engine/src/loop.ts`, `packages/engine/src/portfolio.ts`, `packages/engine/test/loop.test.ts`, `packages/sim-executor/src/simExecutor.ts`, `packages/sim-executor/test/simExecutor.test.ts`, `packages/cli/src/commands/backtest.ts` (pass `synthetic price` option; default unchanged for backtests), `packages/cli/test/backtestArgs.test.ts`

**Interfaces:**
- `EquityPoint` gains `equityExecutableLovelace: bigint | null`.
- `interface WorkingPool { poolId: string; reserveBase: bigint; reserveQuote: bigint; feeBps: number }`
- `Executor` becomes `{ fill(intent, at, next, portfolio, working?: WorkingPool): FillResult; markToMarket(portfolio: Readonly<Portfolio>, candle: Candle): bigint | null }`; a filled `FillResult` gains `poolAfter: WorkingPool | null` (reserves after this fill, so the next intent in the same candle trades against a depleted pool).
- `RunEngineDeps` gains:
  - `sinks?: { onOrder?(o: OrderRecord): Promise<void>; onEquity?(e: EquityPoint): Promise<void>; onCandle?(c: Candle): Promise<void> }` — each awaited before the loop advances.
  - `retain?: boolean` (default `true`); when `false`, `RunResult.orders` and `RunResult.equity` are empty arrays and the summary is computed incrementally by a `Summarizer` (same numbers as `summarize`, proven by a test that runs both ways on one feed).
  - `startSeq?: number` (default 0): the first order gets `startSeq + 1`.
  - `signal?: AbortSignal`: after the current candle is fully processed, the loop stops; intents still pending are recorded as rejected `stopped`.
- `FillModel` synthetic variant gains `price?: 'close' | 'worst'` (default `'close'` to keep existing backtests identical; Plan 3's recommendation is `'worst'`; the CLI flag `--synthetic-price worst|close` defaults to `close` and records the choice in `runs.params.fillModelDetail`). `worst`: buys use `max(next.open, next.close)`, sells `min(next.open, next.close)` when deriving the synthetic reserves.
- `SimExecutor.markToMarket`: `cpmm_observed` → `cash + cpmmAmountOut(position, reserveBase, reserveQuote, feeBps) − batcher − network` when the candle has reserves and the position is > 0 (0 position → cash); returns `null` when reserves are missing. Synthetic → same math on synthetic reserves at the candle's close. Never throws.
- `equityLovelace` unchanged (mark at close, no fees) — both numbers are stored; the report shows both.

- [ ] **Step 1: Failing tests** (add to `packages/engine/test/loop.test.ts`)

```ts
it('persists through sinks in order and does not retain arrays when retain=false', async () => {
  const seen: string[] = [];
  const feed = [c(0, '1.0'), c(1, '1.0'), c(2, '2.0'), c(3, '2.0'), c(4, '4.0'), c(5, '4.0')];
  const r = await runEngine({ feed, strategy: buyOnceThenSell, executor: passthrough, initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log, retain: false,
    sinks: { onCandle: async (k) => { seen.push(`candle ${k.tickTs.getUTCMinutes()}`); }, onOrder: async (o) => { seen.push(`order ${o.seq}`); }, onEquity: async (e) => { seen.push(`equity ${e.tickTs.getUTCMinutes()}`); } } });
  expect(r.orders).toEqual([]); expect(r.equity).toEqual([]);
  expect(r.summary.filled).toBe(2);
  expect(seen.slice(0, 5)).toEqual(['candle 0', 'equity 0', 'candle 5', 'equity 5', 'order 1']); // order settles at t+1 BEFORE that candle's equity? see ordering note
});
it('summary is identical with retain true or false', async () => {
  const feed = Array.from({ length: 40 }, (_, i) => c(i, (1 + 0.1 * Math.sin(i / 3)).toFixed(6)));
  const a = await runEngine({ feed, strategy: buyOnceThenSell, executor: passthrough, initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log });
  const b = await runEngine({ feed, strategy: buyOnceThenSell, executor: passthrough, initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log, retain: false });
  expect(b.summary).toEqual(a.summary);
});
it('startSeq continues numbering and an abort stops after the current candle with pending intents marked stopped', async () => {
  const ac = new AbortController();
  const s: Strategy = { id: 'always', warmup: 1, defaultParams: {}, warmupFor: () => 1, onCandle: () => [{ side: 'buy', amountIn: 1_000_000n, reason: 'x' }] };
  let n = 0;
  const feed = { async *[Symbol.asyncIterator]() { while (n < 100) { const k = c(n++, '1.0'); if (n === 3) ac.abort(); yield k; } } };
  const r = await runEngine({ feed, strategy: s, executor: passthrough, initial: { cashLovelace: 10_000_000_000n, positionBase: 0n }, decimals: 0, log, startSeq: 10, signal: ac.signal });
  expect(r.orders[0]?.seq).toBe(11);
  expect(r.summary.candles).toBe(3);
  expect(r.orders.at(-1)?.result).toEqual({ status: 'rejected', reason: 'stopped' });
});
it('threads poolAfter into the next intent of the same candle', async () => {
  const seenWorking: Array<WorkingPool | undefined> = [];
  const recording: Executor = {
    fill(intent, at, next, portfolio, working) {
      seenWorking.push(working);
      const r = passthrough.fill(intent, at, next, portfolio);
      return r.status === 'filled' ? { ...r, poolAfter: { poolId: 'p', reserveBase: 1n + BigInt(seenWorking.length), reserveQuote: 1n, feeBps: 30 } } : r;
    },
    markToMarket: () => null,
  };
  const twoBuys: Strategy = { id: 'two', warmup: 1, defaultParams: {}, warmupFor: () => 1, onCandle: (ctx) => (ctx.history.length === 1 ? [{ side: 'buy', amountIn: 1_000_000n, reason: 'a' }, { side: 'buy', amountIn: 1_000_000n, reason: 'b' }] : []) };
  await runEngine({ feed: [c(0, '1.0'), c(1, '1.0')], strategy: twoBuys, executor: recording, initial: { cashLovelace: 10_000_000n, positionBase: 0n }, decimals: 0, log });
  expect(seenWorking[0]).toBeUndefined();
  expect(seenWorking[1]).toEqual({ poolId: 'p', reserveBase: 2n, reserveQuote: 1n, feeBps: 30 });
});
it('records equityExecutableLovelace from executor.markToMarket', async () => {
  const mtm: Executor = { ...passthrough, markToMarket: (p) => p.cashLovelace - 1n };
  const r = await runEngine({ feed: [c(0, '1.0'), c(1, '1.0')], strategy: buyOnceThenSell, executor: mtm, initial: { cashLovelace: 1_000_000_000n, positionBase: 0n }, decimals: 0, log });
  expect(r.equity[0]?.equityExecutableLovelace).toBe(999_999_999n);
});
```
Ordering note for the first test: the loop order is settle pending (orders for candle t, filled against candle t+1) → observe (`onCandle`, equity, `onEquity`) → decide. So at candle index 2 the sequence is `order 1`, then `candle 10`, `equity 10`. Write the expected array accordingly: `['candle 0','equity 0','candle 5','equity 5','order 1','candle 10','equity 10', …]`.

Add to `packages/sim-executor/test/simExecutor.test.ts`:
```ts
describe('markToMarket', () => {
  const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: 900_000 });
  const atEq: Candle = { ...at, closeReserveQuote: RQ }; // equal-reserves fixture
  it('values the position as a full sell net of fees on observed reserves (SundaeSwapV3: 1.0 ADA batcher + 0.2 ADA network)', () => {
    expect(ex.markToMarket({ cashLovelace: 0n, positionBase: 1_000_000n }, atEq)).toBe(2_091_631_632n - 1_000_000n - 200_000n);
  });
  it('is cash when flat and null without reserves', () => {
    expect(ex.markToMarket({ cashLovelace: 5n, positionBase: 0n }, atEq)).toBe(5n);
    expect(ex.markToMarket({ cashLovelace: 5n, positionBase: 1n }, { ...atEq, closeReserveBase: null })).toBeNull();
  });
});
describe('reserve depletion', () => {
  const ex = new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_observed' }, maxGapMs: 900_000 });
  const nextEq: Candle = { ...next, closeReserveQuote: RQ };
  it('a second buy in the same candle fills against poolAfter of the first', () => {
    const first = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 'a' }, at, nextEq, rich);
    expect(first).toMatchObject({ status: 'filled', amountOut: 441500n, poolAfter: { poolId: 'SundaeSwapV3:x', reserveQuote: 53331970594n, reserveBase: 23337991n, feeBps: 100 } });
    const working = (first as Extract<FillResult, { status: 'filled' }>).poolAfter!;
    const second = ex.fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 'b' }, at, nextEq, rich, working);
    expect(second).toMatchObject({ status: 'filled', amountOut: 425327n });
  });
});
describe('synthetic worst-of pricing', () => {
  const depth = RQ;
  const ext = (open: string, close: string): Candle => ({ ...next, open, high: close, low: open, close, poolId: null, poolType: null, feeBps: null, closeReserveBase: null, closeReserveQuote: null, tvlLovelace: null, volumeQuote: '1' });
  const buy = (price: 'close' | 'worst') => new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: depth, price }, maxGapMs: 900_000 })
    .fill({ side: 'buy', amountIn: 1_000_000_000n, reason: 't' }, at, ext('0.002300000000000000', '0.002100000000000000'), rich) as Extract<FillResult, { status: 'filled' }>;
  const sell = (price: 'close' | 'worst') => new SimExecutor({ decimals: 0, baseUnit: SNEK, fillModel: { kind: 'cpmm_synthetic_depth', depthLovelace: depth, price }, maxGapMs: 900_000 })
    .fill({ side: 'sell', amountIn: 1_000_000n, reason: 't' }, at, ext('0.002100000000000000', '0.002300000000000000'), rich) as Extract<FillResult, { status: 'filled' }>;
  it('buys at max(open, close) and sells at min(open, close) under worst; close otherwise', () => {
    // buy fixture: open 0.0023, close 0.0021 -> worst prices at the open (0.0023), fewer tokens than the close-priced fill
    expect(buy('worst').amountOut).toBeLessThan(buy('close').amountOut);
    // sell fixture: open 0.0021, close 0.0023 -> worst prices at the open (0.0021), less lovelace than the close-priced fill
    expect(sell('worst').amountOut).toBeLessThan(sell('close').amountOut);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement in `types.ts`, `loop.ts`, `simExecutor.ts`, `backtest.ts` (`--synthetic-price` flag; `buildRunParams` records `fillModelDetail: { syntheticPrice }` when applicable), keeping every existing test green (existing backtests default to `close`, `retain: true`, no sinks).

Loop implementation notes: introduce `class Summarizer` in `loop.ts` that ingests `(order)` and `(equityPoint)` events and computes `RunSummaryStats` at `finish()`; `summarize(orders, equity, candles, ...)` becomes a thin wrapper that feeds a `Summarizer`, so the retain/no-retain paths cannot drift (the "identical summary" test pins it). Coverage accumulates from consecutive `tickTs` deltas without storing candles. Max drawdown and peak are running values. When `retain` is false, `orders`/`equity` arrays are never pushed.

- [ ] **Step 3: Tests, lint, commit; open PR `feat/m3-persistence` (Tasks 2-3), CI green, merge**

```bash
npx vitest run packages/engine packages/sim-executor packages/cli && npm run test:pg -- packages/engine && npm test && npm run lint
git add -A && git commit -m "feat(engine,sim-executor): persistence sinks, bounded memory, abort and resume; mark-to-market, intra-candle reserve depletion, worst-of synthetic pricing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Live candle feed and the `paper` command

**Files:**
- Create: `packages/cli/src/liveFeed.ts`, `packages/cli/src/commands/paper.ts`, `packages/cli/test/liveFeed.test.ts`, `packages/cli/test/paperArgs.test.ts`
- Modify: `packages/cli/src/main.ts` (case + usage), `package.json` (script `"paper": "tsx packages/cli/src/main.ts paper"`)

**Interfaces:**
- `interface LiveFeedDeps { repo: CandleRepo; token: Pick<TokenSpec,'unit'|'decimals'|'ticker'>; intervalSec: number; graceSec: number; maxGapMs: number; now: () => Date; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; signal: AbortSignal; log: Logger; onTick?(info: { boundary: Date; built: number; yielded: number; skippedStale: number }): Promise<void>; afterTick?: Date | null }`
- `liveCandleFeed(d: LiveFeedDeps): AsyncIterable<Candle>` — loop until `signal.aborted`: compute the next boundary from `now()` (`bucketTick(now) + interval`), sleep until `boundary + graceSec` (abortable), call `buildCandlesForToken(repo, token)`, read candles with `tickTs > lastYielded (or afterTick)` and `<= boundary`, and for each: if `now() - tickTs > maxGapMs` skip it with a warn (`stale candle skipped`, counted in `skippedStale`) and do not yield; else yield. Call `onTick` after each boundary with the counts. A boundary with no new candle logs `no candle at <boundary>` at warn. Never throws out of the generator for repository errors: log, count, and continue to the next boundary (the run's heartbeat still moves; the collector's own liveness row says why).
- `interface PaperArgs { strategyId: string; ticker: string; cashAda: number; resume: number | null; intervalSec: number; graceSec: number; maxGapMin: number; rehearsal: boolean; params: Record<string, number> }`
- `parsePaperArgs(args: string[]): PaperArgs` — `paper <strategy> <TICKER> [--cash-ada N] [--resume RUN_ID] [--interval-sec 300] [--grace-sec 60] [--max-gap-min 15] [--rehearsal] [--param k=v]...`; `--rehearsal` requires `CTB_ALLOW_FAKE_DATA=1` in the environment (checked in the command, not the parser; the parser only records the flag).
- `paperCommand(log, args)`:
  1. config (no Blockfrost needed), universe, `ensureTokens`, token lookup, strategy lookup.
  2. `--rehearsal` without `CTB_ALLOW_FAKE_DATA=1` → throw `rehearsal requires CTB_ALLOW_FAKE_DATA=1`. Without `--rehearsal`, refuse to start if `pool_snapshots` for this token contains any `dex = 'Fake'` row in the last 24 h (`rehearsal data present; pass --rehearsal or clean the database`), so synthetic data never leaks into a real run.
  3. New run: `createRun({ mode: 'paper', strategyId, params: buildRunParams(...) + { intervalSec, graceSec, maxGapMs, rehearsal }, gitSha, baseUnit, dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: now, dataTo: now, status: 'running', rehearsal })`; print `run id: N`. Resume: `getRun(resume)` must exist, be `mode = 'paper'`, same `strategyId`, same `baseUnit`, same `params.strategy` values (compare the strategy-param subset), and not `finished`; restore `initial` from `lastEquity` (or `cashAda` if none), `startSeq = lastOrderSeq + 1`, `afterTick = lastEquity.tickTs`, log `resumed run N from <tickTs>`, `setStatus('running', null)`, and push a warning `resumed at <iso>; intents pending at the previous stop were lost` into the run's `warnings` via the summary at finish (record it also as a `paper_orders`-free note in `runs.params.resumes[]` appended with the timestamp; `params` is jsonb, update with `jsonb_set`/read-modify-write inside `RunRepo.appendResume(runId, at)` — add that method to Task 2's list).
  4. Executor: `new SimExecutor({ decimals, baseUnit, fillModel: { kind: 'cpmm_observed' }, maxGapMs })`.
  5. `runEngine` with `liveCandleFeed`, `retain: false`, `startSeq`, `signal`, `intervalSec`, `maxGapMs`, and sinks: `onOrder → runs.insertOrders(runId, unit, [o])`, `onEquity → runs.insertEquity(runId, [e])`, `onCandle → runs.heartbeat(runId, now, candle.tickTs)`; `liveCandleFeed.onTick → runs.heartbeat(runId, now, null)` (a heartbeat even when no candle arrived).
  6. SIGINT/SIGTERM → `ac.abort()` once; the loop finishes the current candle; then `finishRun(runId, now, summary)` and `setStatus('finished', 'signal')`. Any uncaught error → `setStatus('aborted', message)` (no PHI/secret in message; it is our own error text), rethrow. `db.end()` in `finally`.
  7. Print the report (`printReport`) at exit, headed `REHEARSAL` when `rehearsal`.

- [ ] **Step 1: Failing unit tests**

`packages/cli/test/liveFeed.test.ts` — with a fake `CandleRepo` (in-memory candles keyed by tickTs; `transaction` runs `fn(this)`), a controllable clock and an abortable fake sleep that advances the clock by the requested ms:
- boundary math: starting at 12:07:41 with interval 300 and grace 60, the first sleep is to 12:11:00 (139 000 + 60 000 ms).
- yields new candles ≤ boundary in order, never re-yields, respects `afterTick`.
- a candle whose `tickTs` is older than `maxGapMs` at arrival is skipped and counted (`skippedStale`), and `onTick` reports `{ built, yielded, skippedStale }`.
- a repo error on one boundary is logged and the generator continues to the next boundary.
- aborting during sleep ends the iteration without yielding further.

`packages/cli/test/paperArgs.test.ts` — defaults (`cashAda 1000, intervalSec 300, graceSec 60, maxGapMin 15, rehearsal false, resume null`), `--resume 12`, `--rehearsal`, rejects `--interval-sec 10` (< 60), unknown flag, empty `--param`.

- [ ] **Step 2: Implement** `liveFeed.ts` (as specified; reuse `bucketTick` from `@ctb/collector` and `sleep` from `schedule.ts`), `paper.ts`, wiring, script.

`packages/cli/src/liveFeed.ts`:
```ts
import { buildCandlesForToken, type CandleRepo } from '@ctb/candles';
import { bucketTick, type Logger } from '@ctb/collector';
import type { Candle } from '@ctb/engine';
import type { TokenSpec } from '@ctb/universe';

export interface LiveFeedDeps {
  repo: CandleRepo;
  token: Pick<TokenSpec, 'unit' | 'decimals' | 'ticker'>;
  intervalSec: number;
  graceSec: number;
  maxGapMs: number;
  now: () => Date;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  log: Logger;
  onTick?: (info: { boundary: Date; built: number; yielded: number; skippedStale: number }) => Promise<void>;
  afterTick?: Date | null;
}

/**
 * Paper clock (spec §4.4): wait for each interval boundary plus a grace period for the collector's
 * snapshot to land, build the token's candles, and yield the new ones. A candle that is already older
 * than the stale bound when it arrives is skipped and counted, never yielded (spec §6).
 */
export async function* liveCandleFeed(d: LiveFeedDeps): AsyncIterable<Candle> {
  let lastYielded: Date | null = d.afterTick ?? null;
  while (!d.signal.aborted) {
    const now = d.now();
    const boundary = new Date(bucketTick(now, d.intervalSec).getTime() + d.intervalSec * 1000);
    const wakeAt = boundary.getTime() + d.graceSec * 1000;
    await d.sleep(Math.max(0, wakeAt - now.getTime()), d.signal);
    if (d.signal.aborted) return;
    let built = 0;
    let yielded = 0;
    let skippedStale = 0;
    try {
      built = (await buildCandlesForToken(d.repo, d.token)).built;
      const from = lastYielded ? new Date(lastYielded.getTime() + 1) : new Date(0);
      const rows = await d.repo.readCandles(d.token.unit, from, boundary);
      for (const r of rows) {
        const age = d.now().getTime() - r.tickTs.getTime();
        if (age > d.maxGapMs) {
          skippedStale++;
          d.log.warn({ tickTs: r.tickTs, ageMs: age }, 'stale candle skipped');
          lastYielded = r.tickTs; // do not re-read it next boundary
          continue;
        }
        lastYielded = r.tickTs;
        yielded++;
        yield {
          tickTs: r.tickTs, open: r.open, high: r.high, low: r.low, close: r.close, volumeQuote: null,
          poolId: r.poolId, poolType: r.poolType, feeBps: r.feeBps, closeReserveBase: r.closeReserveBase,
          closeReserveQuote: r.closeReserveQuote, tvlLovelace: r.tvlLovelace,
        };
      }
      if (yielded === 0 && skippedStale === 0) d.log.warn({ boundary }, 'no candle at boundary');
    } catch (err) {
      d.log.error({ boundary, err: (err as Error).message ?? String(err) }, 'live feed tick failed; continuing');
    }
    if (d.onTick) await d.onTick({ boundary, built, yielded, skippedStale });
  }
}
```

`packages/cli/src/commands/paper.ts` (core; argument parsing mirrors `parseBacktestArgs`'s style):
```ts
import { PgCandleRepo } from '@ctb/candles';
import { createPool } from '@ctb/db';
import { gitShaOrUnknown, PgRunRepo, runEngine, STRATEGIES, type Portfolio } from '@ctb/engine';
import { SimExecutor } from '@ctb/sim-executor';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { ensureTokens } from '../ensureTokens.js';
import { liveCandleFeed } from '../liveFeed.js';
import { sleep } from '../schedule.js';
import { buildRunParams } from './backtest.js';
import { printReport } from './report.js';

export interface PaperArgs { strategyId: string; ticker: string; cashAda: number; resume: number | null; intervalSec: number; graceSec: number; maxGapMin: number; rehearsal: boolean; params: Record<string, number> }
const USAGE = 'usage: paper <strategy> <TICKER> [--cash-ada N] [--resume RUN_ID] [--interval-sec 300] [--grace-sec 60] [--max-gap-min 15] [--rehearsal] [--param k=v]...';
const ada = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

export function parsePaperArgs(args: string[]): PaperArgs {
  const [strategyId, ticker, ...rest] = args;
  if (!strategyId || !ticker) throw new Error(USAGE);
  const out: PaperArgs = { strategyId, ticker, cashAda: 1000, resume: null, intervalSec: 300, graceSec: 60, maxGapMin: 15, rehearsal: false, params: {} };
  const num = (flag: string, v: string | undefined, min: number): number => {
    const n = Number(v);
    if (v === undefined || v.trim() === '' || !Number.isFinite(n) || n < min) throw new Error(`${flag} needs a number >= ${min}\n${USAGE}`);
    return n;
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!; const val = rest[i + 1];
    switch (flag) {
      case '--cash-ada': out.cashAda = num(flag, val, 0); i++; break;
      case '--resume': out.resume = num(flag, val, 1); i++; break;
      case '--interval-sec': out.intervalSec = num(flag, val, 60); i++; break;
      case '--grace-sec': out.graceSec = num(flag, val, 0); i++; break;
      case '--max-gap-min': out.maxGapMin = num(flag, val, 1); i++; break;
      case '--rehearsal': out.rehearsal = true; break;
      case '--param': {
        const eq = (val ?? '').indexOf('=');
        const k = eq > 0 ? val!.slice(0, eq) : ''; const v = eq > 0 ? val!.slice(eq + 1) : '';
        const n = Number(v);
        if (!k || v.trim() === '' || v.includes('=') || !Number.isFinite(n)) throw new Error(`--param needs key=numeric value\n${USAGE}`);
        out.params[k] = n; i++; break;
      }
      default: throw new Error(`unknown flag ${flag}\n${USAGE}`);
    }
  }
  return out;
}

export async function paperCommand(log: Logger, args: string[]): Promise<void> {
  const a = parsePaperArgs(args);
  const strategy = STRATEGIES[a.strategyId];
  if (!strategy) throw new Error(`unknown strategy ${a.strategyId}; known: ${Object.keys(STRATEGIES).join(', ')}`);
  if (a.rehearsal && process.env.CTB_ALLOW_FAKE_DATA !== '1') throw new Error('rehearsal requires CTB_ALLOW_FAKE_DATA=1');
  const cfg = loadConfig(process.env, { blockfrost: false });
  const universe = await loadUniverse();
  const token = universe.tokens.find((t) => t.ticker === a.ticker);
  if (!token) throw new Error(`unknown ticker ${a.ticker}; not in universe.json`);
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  const ac = new AbortController();
  const onSignal = (sig: string) => { log.info({ sig }, 'stopping after the current candle'); ac.abort(); };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  let runId: number | null = null;
  const runs = new PgRunRepo(db);
  try {
    await ensureTokens(db, universe);
    if (!a.rehearsal) {
      const fake = await db.query<{ n: string }>(`SELECT count(*) AS n FROM pool_snapshots WHERE base_unit = $1 AND dex = 'Fake' AND tick_ts > now() - interval '24 hours'`, [token.unit]);
      if (Number(fake.rows[0]?.n ?? 0) > 0) throw new Error('rehearsal data present for this token; pass --rehearsal or clean the database');
    }
    const maxGapMs = a.maxGapMin * 60_000;
    const params = { ...strategy.defaultParams, ...a.params };
    let initial: Portfolio = { cashLovelace: ada(a.cashAda), positionBase: 0n };
    let startSeq = 0;
    let afterTick: Date | null = null;
    if (a.resume !== null) {
      const prior = await runs.getRun(a.resume);
      if (!prior || prior.mode !== 'paper') throw new Error(`run ${a.resume} is not a paper run`);
      if (prior.strategyId !== strategy.id || prior.baseUnit !== token.unit) throw new Error(`run ${a.resume} is ${prior.strategyId}/${prior.baseUnit}, not ${strategy.id}/${token.unit}`);
      if (prior.status === 'finished') throw new Error(`run ${a.resume} is finished; start a new run`);
      const last = await runs.lastEquity(a.resume);
      if (last) { initial = { cashLovelace: last.cashLovelace, positionBase: last.positionBase }; afterTick = last.tickTs; }
      startSeq = await runs.lastOrderSeq(a.resume);
      runId = a.resume;
      await runs.appendResume(runId, new Date());
      await runs.setStatus(runId, 'running', null);
      log.info({ runId, afterTick, startSeq }, 'resumed run; intents pending at the previous stop were lost');
    } else {
      const gitSha = gitShaOrUnknown(process.cwd());
      runId = await runs.createRun({
        mode: 'paper', strategyId: strategy.id, gitSha, baseUnit: token.unit, dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: new Date(), dataTo: new Date(),
        params: { ...buildRunParams(strategy.defaultParams, a.params, a.cashAda, null, {}, maxGapMs), intervalSec: a.intervalSec, graceSec: a.graceSec, rehearsal: a.rehearsal },
        status: 'running', rehearsal: a.rehearsal,
      });
    }
    console.log(`run id: ${runId}${a.rehearsal ? ' (REHEARSAL)' : ''}`);
    const id = runId;
    const candleRepo = new PgCandleRepo(db);
    const executor = new SimExecutor({ decimals: token.decimals, baseUnit: token.unit, fillModel: { kind: 'cpmm_observed' }, maxGapMs });
    const feed = liveCandleFeed({
      repo: candleRepo, token, intervalSec: a.intervalSec, graceSec: a.graceSec, maxGapMs, now: () => new Date(), sleep, signal: ac.signal, log, afterTick,
      onTick: async () => { await runs.heartbeat(id, new Date(), null); },
    });
    const result = await runEngine({
      feed, strategy, params: a.params, executor, initial, decimals: token.decimals, log, retain: false, startSeq, signal: ac.signal, intervalSec: a.intervalSec, maxGapMs,
      sinks: {
        onOrder: async (o) => { await runs.insertOrders(id, token.unit, [o]); },
        onEquity: async (e) => { await runs.insertEquity(id, [e]); },
        onCandle: async (c) => { await runs.heartbeat(id, new Date(), c.tickTs); },
      },
    });
    await runs.finishRun(id, new Date(), result.summary);
    await runs.setStatus(id, 'finished', ac.signal.aborted ? 'signal' : 'feed ended');
    const run = await runs.getRun(id);
    if (run) printReport(run, await runs.listOrders(id), token.ticker);
  } catch (err) {
    if (runId !== null) await runs.setStatus(runId, 'aborted', (err as Error).message ?? String(err)).catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}
```
Note: `.catch(() => undefined)` on the abort-status write is deliberate: the original error must win. Add `// intentional: original error wins` inline so ESLint's `no-empty` is satisfied if the linter treats the arrow body as a block. Add `RunRepo.appendResume(runId: number, at: Date): Promise<void>` (`UPDATE runs SET params = jsonb_set(params, '{resumes}', coalesce(params->'resumes','[]'::jsonb) || to_jsonb($2::text)) WHERE id = $1`) with a pg test in `repo.pg.test.ts`.

- [ ] **Step 3: Tests, lint, commit** (PR `feat/m3-paper` continues in Task 5)

```bash
npx vitest run packages/cli && npm run test:pg -- packages/engine && npm test && npm run lint
git add -A && git commit -m "feat(cli): live candle feed and paper command with incremental persistence, stale refusal, resume, and clean stop

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Daily report and `status` for paper runs

**Files:**
- Modify: `packages/cli/src/commands/report.ts` (`--day`, REHEARSAL header, assumed-venue warning already from Task 1, executable equity line), `packages/cli/src/commands/status.ts` (running paper runs table), `packages/cli/test/reportDay.test.ts` (new), `packages/cli/src/main.ts` (usage)

**Interfaces:**
- `report <run-id> [--day YYYY-MM-DD]` — with `--day`: prints the UTC-day window, first and last equity point of the day (mark-to-market and executable), the day's return, orders in the day (filled/rejected with reasons; a `stale t+1` count called out), fees paid, and the heartbeat age. Without `--day`: unchanged plus, for paper runs, `status`, `heartbeat_at`, `last_tick_ts`, and a `resumes` line from `params`.
- `dayWindow(day: string): { from: Date; to: Date }` pure; `summarizeDay(equity: EquityPoint[], orders: OrderRecord[]): DaySummary` pure and unit-tested (returnPct from first/last equity, fills, rejects by reason, feesLovelace, staleRejects).
- Header line for `rehearsal` runs starts with `REHEARSAL — synthetic data — not evidence`.
- `status` gains a table of `runs.status = 'running'` with `id, strategy, ticker, rehearsal, heartbeat age (s), last tick, created`; a heartbeat older than `2 × intervalSec + graceSec` (read from `params`) prints `STALE` in the age column.

- [ ] **Step 1: Failing unit tests** for `dayWindow` (boundaries in UTC; rejects a malformed day) and `summarizeDay` (two equity points, three orders including a `stale t+1` rejection → counts and return computed from bigint equity via basis points).
- [ ] **Step 2: Implement**; `report --day` reads `listEquity(runId, from, to)` and `listOrdersBetween(runId, from, to)`; no other query paths.
- [ ] **Step 3: Tests, lint, commit; PR `feat/m3-paper` (Tasks 4-5) → main, CI green, merge**

```bash
npx vitest run packages/cli && npm test && npm run lint
git add -A && git commit -m "feat(cli): daily paper report and running-run status with heartbeat age

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Rehearsal tool — `dev:fake-collector`

**Files:**
- Create: `packages/cli/src/commands/devFakeCollector.ts`, `packages/cli/src/fakeWalk.ts`, `packages/cli/test/fakeWalk.test.ts`, `packages/cli/test/devFakeCollectorGuard.test.ts`
- Modify: `packages/cli/src/main.ts`, `package.json` (script `"dev:fake-collector": "tsx packages/cli/src/main.ts dev:fake-collector"`)

**Interfaces:**
- `mulberry32(seed: number): () => number` and `fakeWalk(seed: number, steps: number, start: { reserveBase: bigint; reserveQuote: bigint }): Array<{ reserveBase: bigint; reserveQuote: bigint }>` — deterministic constant-product random walk: each step swaps a random 0-0.5% of the ADA side in or out through `cpmmAmountOut`, so reserves stay consistent with real pool mechanics; unit test pins the first three states for seed 42.
- `dev:fake-collector <TICKER> [--interval-sec 60] [--seed 42] [--once]` — refuses unless `process.env.CTB_ALLOW_FAKE_DATA === '1'` AND the `DATABASE_URL` host is `localhost` or `127.0.0.1` (parse with `new URL`). Each boundary: writes one `collector_runs` row with `errors = [{ scope: 'fake', message: 'synthetic snapshot from dev:fake-collector' }]` and one `pool_snapshots` row `dex = 'Fake'`, `pool_id = 'Fake:<ticker>'`, `pool_type = 'cpmm'`, `fee_bps = 30`, reserves from the walk continued from the last fake snapshot (or the seed start `reserveBase = 20_000_000 × 10^decimals`, `reserveQuote = 50_000 ADA`), `block_height = 0`, `observed_at = now`. Uses `PgSnapshotRepo` (`startRun`, `insertSnapshots`, `finishRun`) so the liveness row is real.
- **`Fake` is not a Dexter venue**, so `poolToSnapshot` would reject it; the fake collector builds `SnapshotRow` directly (it is the only writer allowed to do so) and `isDexName('Fake')` stays false. `costsForPoolId('Fake:x')` is unknown → the executor's unknown-venue rejection would block every fill; therefore `paper --rehearsal` passes `costOverrides` AND the executor gets a `rehearsalVenue: 'Fake'` option that maps `Fake` to `DEFAULT_COSTS` (only when `--rehearsal`). Add that option to `SimExecutorOptions` in this task, with a test that a `Fake:` pool fills only when `rehearsalVenue` is set.
- The `candles` builder treats `Fake` pools like any other (`pool_type` cpmm, deepest by TVL); with no real snapshots for the token, the fake pool is the only one.

- [ ] **Step 1: Failing tests** — `fakeWalk` determinism and CPMM consistency (`reserveBase × reserveQuote` never decreases by more than the fee rounding); the guard test spawns `parseFakeCollectorArgs` + `assertFakeAllowed(env, databaseUrl)` and asserts refusal without the env var, with a non-localhost host, and acceptance with both satisfied.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Rehearse the whole loop locally (no key needed)** in three terminals or with `&`:

```bash
export CTB_ALLOW_FAKE_DATA=1 DATABASE_URL=postgres://ctb:ctb_local_only@localhost:5433/ctb
npm run dev:fake-collector -- SNEK --interval-sec 60 --seed 42 &          # synthetic snapshots every minute
npm run paper -- ma-crossover SNEK --rehearsal --interval-sec 60 --grace-sec 5 --param fast=3 --param slow=6 &
sleep 900; npm run status                                                  # run row heartbeat within 2 min, candles growing
kill -INT %2; sleep 5; npm run report -- <run-id>                          # finished, reason signal, REHEARSAL header
npm run paper -- ma-crossover SNEK --rehearsal --resume <run-id> --interval-sec 60 --grace-sec 5 --param fast=3 --param slow=6 &
sleep 600; kill -INT %2; npm run report -- <run-id> --day $(date -u +%F)
kill %1
```
Expected: `run_equity` has one row per minute the paper process was up; `paper_orders` seq continues across the resume; `runs.params.resumes` has one timestamp; status showed the run with a fresh heartbeat; the report header says `REHEARSAL`. Then verify the isolation rule: without `--rehearsal`, `npm run paper -- ma-crossover SNEK` must refuse with `rehearsal data present`. Clean up: `DELETE FROM pool_snapshots WHERE dex = 'Fake'; DELETE FROM candles WHERE pool_id LIKE 'Fake:%';` (document this in the report; both tables allow DELETE for the local `ctb` role).
- [ ] **Step 4: Tests, lint, commit; PR `feat/m3-rehearsal` → main, CI green, merge**

```bash
git add -A && git commit -m "feat(cli): dev:fake-collector rehearsal tool, guarded by env and localhost; paper --rehearsal isolation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: M3 acceptance — the 7-day paper run (runbook; needs the Blockfrost key and M1)

**Files:**
- Create: `docs/ops/2026-09-XX-m3-report.md`

- [ ] **Step 1: Preconditions** (all must be true; record each with its evidence)
  - Blockfrost project id in `.env`; `npm run test:live` green; M1 report exists (`docs/ops/*-m1-report.md`) showing ≥ 24 h of `collector_runs` without gaps; `npm run candles` has built real candles for the token (`SELECT count(*), min(tick_ts), max(tick_ts) FROM candles WHERE base_unit = <unit> AND pool_id NOT LIKE 'Fake:%'`); no `Fake` rows in the last 24 h; one `--source candles` backtest ran (the first `cpmm_observed` run on real data) and its report is pasted in the M3 report.
- [ ] **Step 2: Start** (collector already running under its own `caffeinate`)
```bash
set -a && source .env && set +a
caffeinate -is npm run paper -- ma-crossover SNEK > paper.log 2>&1 &
echo $! > paper.pid
```
- [ ] **Step 3: Daily, for 7 days**: `npm run report -- <run-id> --day <yesterday UTC>` pasted into the report; `npm run status` heartbeat age; note any `stale t+1` or `no candle at boundary` counts and cross-reference `collector_runs` errors for the same hour.
- [ ] **Step 4: Restart drill on day 2**: `kill -INT $(cat paper.pid)`; confirm `runs.status = 'finished'` with `stop_reason = 'signal'`; wait one interval; `npm run paper -- ma-crossover SNEK --resume <run-id>`; confirm `paper_orders.seq` continues and `params.resumes` gained a timestamp.
- [ ] **Step 5: Acceptance queries**
```sql
SELECT id, status, stop_reason, created_at, finished_at, heartbeat_at, last_tick_ts, params->'resumes' AS resumes FROM runs WHERE mode = 'paper' ORDER BY id;
SELECT date_trunc('day', tick_ts) AS day, count(*) AS points, min(equity_lovelace), max(equity_lovelace) FROM run_equity WHERE run_id = <id> GROUP BY 1 ORDER BY 1;
SELECT status, reject_reason, count(*) FROM paper_orders WHERE run_id = <id> GROUP BY 1, 2 ORDER BY 3 DESC;
SELECT count(*) FILTER (WHERE equity_executable_lovelace IS NULL) AS unpriced, count(*) AS total FROM run_equity WHERE run_id = <id>;
```
- [ ] **Step 6: Write the report**: preconditions with evidence; the seven daily reports verbatim; the restart drill; the four query outputs; the venues touched and whether any were `assumed`; the sentence "this is a plumbing check, not a strategy result" beside the P&L; verdict "M3 met" or "M3 not met because …" against spec §8 M3 ("`paper` has run for 7 days; daily report cites run id, git sha, fills, costs"). Commit on `docs/m3-report`, PR, merge.

---

## PR grouping (each off `main`; never stacked)

| PR | Branch | Tasks |
| --- | --- | --- |
| costs | `feat/m3-costs` | 1 (founder reviews alone; changes reported numbers) |
| persistence | `feat/m3-persistence` | 2, 3 |
| paper | `feat/m3-paper` | 4, 5 |
| rehearsal | `feat/m3-rehearsal` | 6 |
| M3 report | `docs/m3-report` | 7 |

## Open items the founder decides

1. **Blockfrost key and M1** gate Task 7 entirely. Tasks 1-6 are buildable and rehearsable without it.
2. **Synthetic pricing default.** This plan keeps `close` as the backtest default so M2's numbers stay reproducible, and adds `--synthetic-price worst`. Flipping the default is a one-line change you may want after seeing both on the same run.
3. **MinswapV2 batcher fee.** Two first-party sources conflict; the value stays `assumed` at 2 ADA until an on-chain check (a real Minswap v2 order UTxO's batcher fee field) settles it. That check needs the Blockfrost key too.

## Deviations from the spec, recorded

- Spec §4.4 "the paper clock waits for the next candle": implemented as boundary + grace + self-build, because the collector and the paper process are separate processes and a candle exists only after `buildCandlesForToken` runs.
- Spec §6 stale rule is enforced twice on purpose: the feed skips a candle already older than `maxGapMs` on arrival, and the executor rejects a fill whose `t → t+1` gap exceeds it. Both are counted.
- Spec §8 M3 says "daily report"; implemented as `report --day` run by the operator (or their cron), not by the paper process, so a reporting failure can never stop trading logic and vice versa.

## Plan self-review (done at writing time)

- Spec coverage: §4.4 paper clock = Task 4 (`liveCandleFeed`); §4.5 unchanged semantics plus mark-to-market and depletion (Task 3); §4.6 `paper` (Task 4), `report --day` (Task 5); §5 new table `run_equity` and run columns (Task 2); §6 stale refusal (Tasks 3, 4), counted skips everywhere; §7 determinism preserved (Task 3's retain-equivalence test), guards proven red (Task 1 provenance guard, Task 6 fake guard); §8 M3 = Task 7.
- Final-review carry-overs closed here: I6 (Tasks 2-3), per-venue costs (Task 1), worst-of synthetic pricing and reserve depletion and executable equity (Task 3), assumed-venue warning (Task 1), `--param k=1=2` (Task 4's parser splits on the first `=` and rejects a second).
- Type consistency: `EquityPoint.equityExecutableLovelace`, `WorkingPool`, `FillResult.poolAfter`, `Executor.markToMarket`, `RunEngineDeps.{sinks,retain,startSeq,signal}`, `RunRepo.{insertEquity,lastEquity,listEquity,lastOrderSeq,listOrdersBetween,heartbeat,setStatus,listRunning,appendResume}`, `LiveFeedDeps`, `PaperArgs` are each defined in one task and consumed by name in the later ones. `run_equity` has 7 columns; `insertEquity` pushes 7 values per row.
- Placeholder scan: Task 5's tests are specified in prose with exact expectations; Task 4 and 6 carry code; the report filename date is the only "XX".
