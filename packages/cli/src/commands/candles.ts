import { buildCandlesForToken, PgCandleRepo } from '@ctb/candles';
import { PgSnapshotRepo } from '@ctb/collector';
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
    // candles reads pool_snapshots/writes candles, both FK'd to tokens(unit) via base_unit. A
    // fresh database should still end up with `tokens` populated by any command that reads the
    // universe, not only `collect` — mirror collect.ts's sync so `candles` alone on a fresh DB
    // doesn't silently build against a `tokens` table nothing has ever seeded.
    await new PgSnapshotRepo(db).syncTokens(universe.tokens, { seededAt: universe.seededAt, seedSource: universe.seedSource });
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
