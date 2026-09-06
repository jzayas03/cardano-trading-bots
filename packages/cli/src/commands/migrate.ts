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
