import { buildCandlesForToken, PgCandleRepo } from '@ctb/candles';
import { createPool } from '@ctb/db';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { ensureTokens } from '../ensureTokens.js';

export async function candlesCommand(log: Logger, opts: { ticker?: string }): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: false });
  const universe = await loadUniverse();
  const tokens = opts.ticker ? universe.tokens.filter((t) => t.ticker === opts.ticker) : universe.tokens;
  if (tokens.length === 0) throw new Error(`unknown ticker ${opts.ticker ?? ''}; not in universe.json`);
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    await ensureTokens(db, universe);
    const repo = new PgCandleRepo(db);
    const out: Array<{ ticker: string; built: number; from: string; to: string }> = [];
    for (const t of tokens) {
      const r = await buildCandlesForToken(repo, t, cfg.intervalSec);
      out.push({ ticker: t.ticker, built: r.built, from: r.from?.toISOString() ?? '-', to: r.to?.toISOString() ?? '-' });
    }
    console.table(out);
  } finally {
    await db.end();
  }
}
