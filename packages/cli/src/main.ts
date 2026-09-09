import 'dotenv/config';
import pino from 'pino';
import { backfillCommand } from './commands/backfill.js';
import { backupCommand, backupVerifyCommand } from './commands/backup.js';
import { backtestCommand } from './commands/backtest.js';
import { candlesCommand } from './commands/candles.js';
import { collectCommand } from './commands/collect.js';
import { dashboardCommand } from './commands/dashboard.js';
import { devFakeCollectorCommand } from './commands/devFakeCollector.js';
import { leadlagCommand } from './commands/leadlag.js';
import { lpCommand } from './commands/lp.js';
import { opportunityCommand } from './commands/opportunity.js';
import { migrateCommand } from './commands/migrate.js';
import { paperCommand } from './commands/paper.js';
import { reportCommand } from './commands/report.js';
import { statusCommand } from './commands/status.js';
import { watchCommand } from './commands/watch.js';
import { doctorCommand } from './commands/doctor.js';

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
      return statusCommand(log, rest);
    case 'doctor':
      return doctorCommand(log);
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
    case 'dashboard':
      return dashboardCommand(log, rest);
    case 'leadlag':
      return leadlagCommand(log, rest);
    case 'opportunity':
      return opportunityCommand(log, rest);
    case 'lp':
      return lpCommand(log, rest);
    case 'watch':
      return watchCommand(log, rest);
    case 'backup':
      return backupCommand(log, rest);
    case 'backup:verify':
      return backupVerifyCommand(log, rest);
    default:
      console.error(
        'usage: tsx packages/cli/src/main.ts <migrate|doctor|collect [--once]|status [--digest]|candles [TICKER]|backfill <TICKER|ALL> <from-ISO> <to-ISO> [--spacing-sec 3]|' +
        'backtest <strategy>[,<strategy>...] <TICKER|ALL> <from-ISO> <to-ISO> [--source candles|external] [--cash-ada N] [--depth-ada N|auto] [--batcher-ada N] [--network-ada N] [--param k=v]...|' +
        'report <run-id> [--day YYYY-MM-DD] [--csv <dir>] | report --compare <ids>|' +
        'paper <strategy> <TICKER> [--cash-ada N] [--resume RUN_ID] [--interval-sec COLLECT_INTERVAL_SECONDS] [--allow-interval-mismatch] [--grace-sec 60] [--max-gap-min 15] [--max-tick-failures 12] [--rehearsal] [--param k=v]...|' +
        'dev:fake-collector <TICKER> [--interval-sec 60] [--seed 42] [--once]|' +
        'dashboard [--port 3210] | watch [--verbose] | leadlag [--max-lag 6] [--since ISO] |\n' +
        ' opportunity [TICKER|ALL] [--since ISO] [--floor-bps 216] [--windows 1800,7200,86400]>',
        ' lp <TICKER> [--since ISO] [--pool ID]  — LP value by entry tick, vs holding the token>',
      );
      process.exitCode = 2;
  }
}

/**
 * Everything useful about a thrown value, because `err.message` alone can be empty.
 *
 * `pg` fails a connection with an AggregateError whose own message is '' and whose detail lives in
 * `.errors` — so a collector that died because Postgres was down logged `{"err":""} command failed`
 * and told the operator nothing. Seen twice on the M5 host, 2026-09-08.
 */
export function describeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { err: String(err) };
  const out: Record<string, unknown> = { err: err.message || err.name || String(err), name: err.name };
  if (err.stack) out.stack = err.stack.split('\n').slice(0, 4).join(' | ');
  const agg = err as { errors?: unknown[] };
  if (Array.isArray(agg.errors)) {
    out.causes = agg.errors.map((e) => (e instanceof Error ? e.message || e.name : String(e)));
  }
  if (err.cause instanceof Error) out.cause = err.cause.message || err.cause.name;
  return out;
}

main().catch((err: unknown) => {
  log.error(describeError(err), 'command failed');
  process.exitCode = 1;
});
