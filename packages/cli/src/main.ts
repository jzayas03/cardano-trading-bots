import 'dotenv/config';
import pino from 'pino';
import { backfillCommand } from './commands/backfill.js';
import { candlesCommand } from './commands/candles.js';
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
    case 'candles':
      return candlesCommand(log, { ticker: rest[0] });
    case 'backfill':
      return backfillCommand(log, rest);
    default:
      console.error('usage: tsx packages/cli/src/main.ts <migrate|collect [--once]|status|candles [TICKER]|backfill <TICKER> <from-ISO> <to-ISO>>');
      process.exitCode = 2;
  }
}

main().catch((err: Error) => {
  log.error({ err: err.message }, 'command failed');
  process.exitCode = 1;
});
