import 'dotenv/config';
import pino from 'pino';
import { backfillCommand } from './commands/backfill.js';
import { backtestCommand } from './commands/backtest.js';
import { candlesCommand } from './commands/candles.js';
import { collectCommand } from './commands/collect.js';
import { devFakeCollectorCommand } from './commands/devFakeCollector.js';
import { migrateCommand } from './commands/migrate.js';
import { paperCommand } from './commands/paper.js';
import { reportCommand } from './commands/report.js';
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
    case 'backtest':
      return backtestCommand(log, rest);
    case 'report':
      return reportCommand(log, rest);
    case 'paper':
      return paperCommand(log, rest);
    case 'dev:fake-collector':
      return devFakeCollectorCommand(log, rest);
    default:
      console.error(
        'usage: tsx packages/cli/src/main.ts <migrate|collect [--once]|status|candles [TICKER]|backfill <TICKER> <from-ISO> <to-ISO>|' +
        'backtest <strategy>[,<strategy>...] <TICKER> <from-ISO> <to-ISO> [--source candles|external] [--cash-ada N] [--depth-ada N] [--batcher-ada N] [--network-ada N] [--param k=v]...|' +
        'report <run-id> [--day YYYY-MM-DD]|' +
        'paper <strategy> <TICKER> [--cash-ada N] [--resume RUN_ID] [--interval-sec COLLECT_INTERVAL_SECONDS] [--allow-interval-mismatch] [--grace-sec 60] [--max-gap-min 15] [--max-tick-failures 12] [--rehearsal] [--param k=v]...|' +
        'dev:fake-collector <TICKER> [--interval-sec 60] [--seed 42] [--once]>',
      );
      process.exitCode = 2;
  }
}

main().catch((err: Error) => {
  log.error({ err: err.message }, 'command failed');
  process.exitCode = 1;
});
