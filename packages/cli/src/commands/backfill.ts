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
