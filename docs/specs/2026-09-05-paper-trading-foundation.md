# Paper-trading foundation for Cardano DEX bots

Date: 2026-09-05. Status: approved design, pre-implementation.

## 1. Purpose

Build the data pipeline, backtester, and simulated executor that every later
Cardano trading bot runs on. No real funds move. The output of this project is
a paper-trading loop whose numbers can be trusted because the strategy code,
the fill model, and the data provenance are the same in backtest and paper
mode.

Success means: after milestone M3 a strategy has run in paper mode for a week
against live Cardano DEX data, and its daily report cites the run id, git sha,
data range, and every cost applied to every fill.

## 2. Decisions already made

| Decision | Choice | Why |
| --- | --- | --- |
| Bot type | Paper-trading foundation first | Every other bot type builds on it; no funds at risk until the loop is proven |
| Language | TypeScript, Node 24, CommonJS-free ESM is allowed here (new repo, not czi-middleware) | Best Cardano off-chain SDKs (Dexter, Lucid Evolution, MeshJS) live in TS |
| Chain state | Blockfrost free tier | Default provider for every SDK; limits verified at signup |
| Pool state | Dexter SDK polling every 5 minutes | One interface over Minswap v1/v2, SundaeSwap, MuesliSwap, WingRiders v1/v2, VyFinance, Splash |
| Historical backfill | GeckoTerminal free API | Only free source of Cardano DEX OHLCV history found |
| Universe | Top 20 tokens by market cap, each paired with ADA | Seeded once by hand from konnektr.net; committed as JSON, never fetched at runtime |
| Runtime | Local Mac, Docker Compose with Postgres 16 only | Move to AWS after the loop is proven |
| Structure | npm workspaces, five packages plus CLI | Testable units; strategy code identical across modes |

Rejected: single script (two code paths for backtest and paper), adopting the
cardania Trading-Agent-Template (no backtester, OpenAI-driven decisions, paid
TapTools dependency), self-hosted node (cost before proof), paid market-data
APIs (tiers unverifiable today; not needed for the free plan).

## 3. Boundaries

- The software never signs or submits a transaction in this spec. Live
  execution is a separate spec with its own approval.
- Strategy profitability is the operator's judgement. The reference strategy
  exists to prove plumbing, not as a recommendation.
- No personal data is stored. The only secret is a Blockfrost project id, read
  from `.env`, never committed.

## 4. Packages

All under `packages/`. Each has one purpose, a public `index.ts`, and its own
tests. Dependencies point downward only.

### 4.1 `universe`

- Ships `universe.json`: for each token, ticker, policy id, asset name (hex),
  decimals, category tag, date seeded, seed source.
- Exposes `loadUniverse()` returning validated `Pair[]` (token vs ADA).
- Validation fails closed: a malformed entry aborts startup with the entry
  named, it is never skipped.

### 4.2 `collector`

- Every 5 minutes (configurable, default chosen so that 20 pairs across up to
  8 DEX venues stays inside Blockfrost's free tier), calls Dexter to fetch all
  liquidity pools for every pair.
- Writes one `pool_snapshots` row per pool per tick: dex, pool id, reserve
  A, reserve B, pool fee, pool type, TVL in ADA, tip block, timestamp.
- Writes one `collector_runs` row per tick: started, finished, pairs
  attempted, pools written, errors. This row is the liveness signal. A
  missing or failing row is visible in one query; there is no silent skip.
- Rate-limit and transient errors retry with exponential backoff and jitter,
  bounded to the tick length. A pair that fails is recorded as failed for that
  tick; the tick still completes for the others.

### 4.3 `candles`

- Builds 5-minute candles per pair from `pool_snapshots`, using the deepest
  pool by TVL at each tick. Price is the reserve ratio adjusted for decimals.
- Volume footnote (reviewer, 2026-09-05): reserve deltas measure net token
  flow, not gross trading volume. Equal buy and sell pressure inside a window
  nets to near zero. Therefore the local table stores `net_flow_base` and
  `net_flow_quote`, and has no column named `volume`. Gross volume exists only
  in `candles_external` from GeckoTerminal, with `source` set. Reports that
  show volume say which table it came from.
- `candles_external` is imported by the `backfill` command and never merged
  into `candles`. A strategy declares which table it reads.

### 4.4 `engine`

- `Strategy` interface: `id`, `params`, `onCandle(ctx): Intent[]`. `ctx`
  exposes the candle, the indicator helpers, and current paper positions.
  Strategies are pure with respect to time: they receive a clock, they never
  call `Date.now()`.
- One event loop. The backtest clock replays candles from Postgres between
  `from` and `to`. The paper clock waits for the next candle to land. The loop
  code is shared; only the clock and the executor are injected.
- Indicators (RSI, moving averages, volume spike over external volume,
  liquidity change over TVL) are pure functions in `engine/indicators`,
  inspired by the screener sites. Holder growth is deferred: it needs
  per-asset address scans that the free tier cannot afford.
- Reference strategy: moving-average crossover. Plumbing proof only.

### 4.5 `sim-executor`

- Receives an `Intent` at candle `t` and fills it against the real reserves of
  the deepest pool recorded at candle `t+1`. This models the Cardano batcher
  delay: an order placed now is executed by an off-chain batcher one or more
  blocks later, against whatever the pool holds then.
- Fill math: constant-product (`x * y = k`) with the pool's own fee.
- Invariant footnote (reviewer, 2026-09-05): every universe pair is token vs
  ADA, so constant-product is correct for them. Stable-vs-stable pools on
  Minswap v2 and Splash use a stableswap curve. The executor therefore checks
  `pool_type` on every fill and fails closed on anything that is not
  constant-product: the intent is rejected, logged with the pool id and type,
  and counted in the run. It never falls back to the wrong curve.
- Costs applied to every fill and stored per order: pool fee (from the pool),
  batcher fee (per-DEX constant table, about 2 ADA on Minswap), network fee
  (about 0.2 ADA), and the resulting slippage against the `t` mid price.
- Writes `paper_orders`: run id, intent, pool, requested and filled amounts,
  each cost, mid at `t`, execution price at `t+1`, status.

### 4.6 `cli`

Commands: `collect`, `backfill <pair> <from> <to>`, `backtest <strategy>
<from> <to>`, `paper <strategy>`, `report <run-id>`. Every command that
produces numbers creates a `runs` row first and prints its id.

## 5. Data model

Postgres 16, plain SQL migrations under `db/migrations`, applied by a small
runner in `cli`. Tables:

| Table | Key columns | Notes |
| --- | --- | --- |
| `tokens` | policy_id, asset_name, ticker, decimals | Mirror of universe.json; the DB copy is what queries join on |
| `pool_snapshots` | dex, pool_id, pair, reserve_a, reserve_b, fee_bps, pool_type, tvl_ada, block, ts | One row per pool per tick |
| `collector_runs` | started, finished, pairs_attempted, pools_written, errors_json | Liveness |
| `candles` | pair, ts, open, high, low, close, net_flow_base, net_flow_quote, pool_id | Derived from snapshots; no volume column by design |
| `candles_external` | pair, ts, open, high, low, close, volume, source | Imported; never merged |
| `runs` | id, mode, strategy, params_json, git_sha, data_from, data_to, created | Provenance for every number |
| `paper_orders` | run_id, ts_intent, ts_fill, pair, pool_id, side, qty_req, qty_filled, mid_t, px_fill, pool_fee, batcher_fee, network_fee, slippage_bps, status | One row per intent, filled or rejected |

Amounts are stored as `numeric`, never floating point, in the asset's smallest
unit. Timestamps are `timestamptz`.

## 6. Error handling

- Fail closed everywhere data could lie: invalid universe entry, unknown pool
  type, snapshot older than 15 minutes in paper mode (pair marked stale, no
  intents executed for it), missing `t+1` snapshot (order rejected, not filled
  at `t`).
- Every skip is a counted row or a logged line with the reason, never an
  empty catch.
- Collector crashes are contained per tick; the process exits non-zero only on
  configuration errors at startup.

## 7. Testing

- Unit: constant-product fill and fee model against hand-computed cases built
  from real Minswap reserves captured in fixtures. Candle builder against a
  fixture of snapshots including a window where flows net to zero. Universe
  validation rejects each malformed shape.
- Property: same run twice yields byte-identical `paper_orders` (determinism).
- Guard: a test asserts that `candles` has no column named `volume` and that
  `sim-executor` rejects a fixture pool with `pool_type = 'stable'`. Both
  guards are proven red by reinjecting the defect before they are trusted.
- Integration (opt-in, needs `.env`): one live Dexter fetch for one pair,
  asserting shape only.

## 8. Milestones

| Milestone | Done when |
| --- | --- |
| M0 | Repo, workspaces, compose, migrations applied, `universe.json` validated, CI runs lint and unit tests |
| M1 | `collect` has run unattended for 24 h; `collector_runs` shows every tick |
| M2 | `candles` built; `backfill` imported one pair; one `backtest` report with run id |
| M3 | `paper` has run for 7 days; daily report cites run id, git sha, fills, costs |

## 9. Out of scope

Live execution and wallet signing, dashboard UI (screener-style, noted for a
later spec), cross-DEX arbitrage, market making, holder-growth signals, AWS
deployment, paid data APIs.

## 10. Open questions

- Blockfrost free-tier limits are taken from signup, not assumed; the
  collector interval is tuned to the measured limit in M1.
- GeckoTerminal coverage of Cardano pools is partial; M2 records which
  universe pairs have no external history.
- Dexter's pool objects must expose a pool type or an equivalent marker;
  M0 verifies this against the SDK before the executor guard is written.
