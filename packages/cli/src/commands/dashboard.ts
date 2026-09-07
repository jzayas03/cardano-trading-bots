import { PgSnapshotRepo } from '@ctb/collector';
import { createDashboardServer, listen, PgDashboardReads, type DashboardDeps } from '@ctb/dashboard';
import { createPool, listMigrations } from '@ctb/db';
import { PgRunRepo } from '@ctb/engine';
import { checkEnv } from '@ctb/reports';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { listProcesses } from './doctor.js';
import { fakeRowsTotal } from './paper.js';

const DEFAULT_PORT = 3210;
const USAGE = 'usage: dashboard [--port 3210]';

export function parseDashboardArgs(args: string[]): { port: number } {
  let port = DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') {
      const raw = args[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n < 1024 || n > 65535) {
        throw new Error(`--port must be an integer 1024-65535, got ${JSON.stringify(raw)}\n${USAGE}`);
      }
      port = n;
    } else {
      throw new Error(`unknown argument ${a}\n${USAGE}`);
    }
  }
  return { port };
}

/**
 * Serves the read-only dashboard on 127.0.0.1 (not configurable — see `@ctb/dashboard`'s `listen`).
 * Connects with the dashboard's own DB URL (`cfg.dashboardDatabaseUrl`: `ctb_dashboard`, SELECT-only,
 * migration 0006), never with `cfg.databaseUrl`. Every dependency is the CLI's own real repo or check.
 */
export async function dashboardCommand(log: Logger, args: string[]): Promise<void> {
  const { port } = parseDashboardArgs(args);
  const cfg = loadConfig(process.env, { blockfrost: false });
  const db = createPool(cfg.dashboardDatabaseUrl, (err) => log.error({ err: err.message }, 'dashboard pg pool error'));
  const runRepo = new PgRunRepo(db);
  const snapshotRepo = new PgSnapshotRepo(db);
  const universe = await loadUniverse();
  const tickerOf = (unit: string): string => universe.tokens.find((t) => t.unit === unit)?.ticker ?? unit;
  // The other direction of `tickerOf`, for `/runs?ticker=` — a pure universe lookup, not a query.
  const unitOf = (ticker: string): string | undefined => universe.tokens.find((t) => t.ticker === ticker)?.unit;
  // Finding I3 (review round 1): every ticker the universe knows about — a pure in-memory list, no
  // query — so the filter form always offers every ticker, not just whatever the current (already
  // filtered) page happens to show.
  const tickers = (): string[] => universe.tokens.map((t) => t.ticker);

  const deps: DashboardDeps = {
    reads: new PgDashboardReads(db),
    runs: runRepo,
    collector: { digestInput: (intervalSec, venues, now) => snapshotRepo.digestInput(intervalSec, venues, now) },
    processes: listProcesses,
    migrations: async () => {
      const onDisk = await listMigrations();
      const applied = await db.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename');
      return { onDisk, applied: applied.rows.map((r) => r.filename) };
    },
    fakeRows: () => fakeRowsTotal(db),
    // `checkEnv` is computed here, in the CLI, and handed to the server as a plain `Check[]` — the
    // dashboard package itself never reads `process.env` (spec's "secrets never rendered"; the health
    // page shows the Blockfrost key by length, same as `doctor`).
    envChecks: () => checkEnv(process.env),
    tickerOf,
    unitOf,
    tickers,
    intervalSec: cfg.intervalSec,
    venues: cfg.venues,
    now: () => new Date(),
    log: { info: (o, m) => log.info(o, m), error: (o, m) => log.error(o, m) },
  };

  const server = createDashboardServer(deps);
  const { url } = await listen(server, port);
  console.log(`dashboard: ${url} (read-only, localhost only; Ctrl-C to stop)`);

  // The listening server itself keeps the process alive; a signal closes it and ends the pool so
  // node has no handles left and exits on its own, the same shape collectCommand's AbortController
  // uses — no process.exit() (see also that other commands never call it, only set exitCode).
  let shuttingDown = false;
  const shutdown = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ sig }, 'dashboard stopping');
    server.close(() => {
      void db.end();
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
