# Runbook: `collect` (the M1 collector)

Operating the snapshot collector as a long-running process: start, check, watch the Blockfrost
budget, stop, recover. Written after the first real day of running it (run 52 onward, 2026-09-07).
The paper-mode runbook is `docs/ops/RUNBOOK-paper.md`; it assumes this process is running.

## Before anything: `npm run doctor`

Node version, `.env` (key present by length only, interval vs default), database and migrations,
duplicate collector/paper processes, rehearsal leftovers, disk, and the digest's collector/quota
lines. Exit code 1 on any FAIL. Two of tonight's incidents (2026-09-07: a duplicate collector, a
stale `COLLECT_INTERVAL_SECONDS=300`) are checks here now.

## What one day costs

Blockfrost's free plan allows 50,000 requests per day, reset at 00:00 UTC. The collector spends
that budget in two ways:

- **Discovery** — one scan per venue at start and again every 24 hours (`REDISCOVER_AFTER_MS`).
  Measured 2026-09-07 with the default 6 venues: 5,691 calls, 9 minutes.
- **Refresh** — every boundary in between, one state read per kept pool. With
  `COLLECT_REFRESH=deepest` that is one pool per universe token (20). Measured ~10 calls per pool on SundaeSwapV3, whose pools share one script address;
  the first day of refresh ticks measures the other venues.

The `.env.example` comments carry the arithmetic. The Blockfrost dashboard counter is the budget
authority, not `provider_calls` — the two agree on a clean day and only the dashboard counts
retries the SDK made on our behalf.

## Start

```bash
set -a && source .env && set +a
nohup caffeinate -is npm run collect > collect.log 2>&1 &
echo $! > collect.pid
pgrep -fl 'main.ts collect' | head -1
```

The last line must print one process. `collect.pid` holds the **wrapper's** pid (`caffeinate`),
not the collector's; it is only useful for `ps`. Stop by process name (below), never by that file:
killing the wrapper leaves the collector running and only drops the sleep prevention.

`COLLECT_INTERVAL_SECONDS` is read from `.env`, and `.env` silently overrides the code default.
The first day of running found a stale `300` from an older `.env.example`; check before starting:

```bash
grep -c '^COLLECT_INTERVAL_SECONDS=600' .env    # 1, or the line is absent (also fine)
```

## Check

```bash
npm run status
```

- **run table** — newest first. A row per boundary; `discovered: true` marks a discovery tick and
  its `calls` will be in the thousands. Refresh rows should sit near `20 * <calls per pool>`.
  `finished: NO` on any row but the newest means that tick died mid-way (see recovery).
- **`ticks missing in last 24h`** — counted against the interval. It stays high for the first day
  after a restart and is a real signal only once the process has run a full 24 hours.
- **top venues by calls** — from the last discovery tick. A venue that suddenly costs several
  times its measured figure is where to look first (the Splash scan cost 24,000 calls for nothing
  before it was turned off).

Read the Blockfrost dashboard alongside it. If the counter is on a pace to cross 50,000 before
00:00 UTC, stop the collector; a tick that starts past the cap records every venue as
`discover:<venue>` failures and writes nothing useful.

## A venue that returns no pools

Dexter turns any on-chain error into an empty pool list, and Blockfrost answered HTTP 504 for
MinswapV2's validity-asset address list at 00:20 UTC on 2026-09-07 while the same request got 200 a
minute later. So an empty answer is retried: up to 3 more attempts spaced 15 s, 30 s, 60 s inside the
discovery tick, and if the venue is still empty it is recorded as one `discover:<venue>` failure and
**retried on every following tick** until it returns. A returning venue's pools are written with the
tick that found them and its scan cost lands in that row's `discovery_calls` (the digest counts it as
one-off discovery cost, not recurring refresh). `status --digest` says `venues LOST since the last
discovery` while it is out and drops the line once it is back. No restart is needed.

## Stop

```bash
pkill -TERM -f 'main.ts collect'
```

The collector finishes the tick in flight, logs `collector stopped`, and exits; `caffeinate`
exits with it. `collect.pid` can then be deleted.

## Recover

The collector keeps no state between ticks beyond the rows it wrote, so recovery is a restart.
A crash leaves the newest `collector_runs` row with `finished: NO` and no snapshots for that
boundary; the next start rediscovers and continues. Nothing has to be repaired or replayed.

Before restarting, confirm the old process is really gone:

```bash
pgrep -fl 'main.ts collect'     # must be empty
```

Two collectors writing the same boundary would double the Blockfrost spend and race the run rows.

## What the snapshots can and cannot say

Each boundary stores one reserve reading per kept pool. A candle built from them
(`npm run candles`) therefore has **open, high, low and close all equal** — one reading, one
price — and its flow columns are net reserve change between boundaries, not traded volume. Any
indicator that reads intra-candle range sees zero range on these candles. Backtests over
`--source candles` refuse `--synthetic-price worst` for exactly this reason; paper mode fills
against observed reserves and never needs an assumed intra-candle price.
