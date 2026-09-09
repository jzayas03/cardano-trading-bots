import type { Denomination } from '@ctb/candles';
import { backfillToken, GeckoTerminalClient, PgExternalRepo } from '@ctb/candles';
import { createPool } from '@ctb/db';
import { loadUniverse } from '@ctb/universe';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { ensureTokens } from '../ensureTokens.js';

export function parseIsoDate(label: string, s: string | undefined): Date {
  const d = s ? new Date(s) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} must be an ISO date, got ${s ?? '(missing)'}`);
  return d;
}

export interface BackfillRow { ticker: string; pool: string; method: string; pages: number; newRows: number; calls: number; coverageFirst: string; coverageLast: string; coverageRows: number }

/**
 * Every token in turn; one token's failure (no GeckoTerminal pool, a page that never came) is a
 * row in `failures`, never the end of the sweep. Tokens are strictly sequential: the client's
 * polite spacing (3 s between calls, 429 otherwise) is per client, and one client is shared.
 */
export async function backfillAll(
  tokens: Array<{ ticker: string }>, one: (ticker: string) => Promise<BackfillRow>, log: { warn(obj: object, msg: string): void },
): Promise<{ rows: BackfillRow[]; failures: Array<{ ticker: string; error: string }> }> {
  const rows: BackfillRow[] = [];
  const failures: Array<{ ticker: string; error: string }> = [];
  for (const t of tokens) {
    try {
      rows.push(await one(t.ticker));
    } catch (err) {
      const error = (err as Error).message ?? String(err);
      failures.push({ ticker: t.ticker, error });
      log.warn({ ticker: t.ticker, err: error }, 'backfill failed for token; continuing with the next');
    }
  }
  return { rows, failures };
}

const USAGE = 'usage: backfill <TICKER|ALL> <from-ISO> <to-ISO> [--spacing-sec 3] [--currency ada|usd]';

/**
 * `--spacing-sec N`: the base wait between GeckoTerminal calls (the client widens it on 429s and
 * decays back). Null when not given.
 *
 * `--currency ada|usd`, default **ada**. GeckoTerminal defaults to USD and this project asked for
 * neither until 2026-09-09, so three months of `candles_external` are dollars while every cost the
 * project compares against is ADA. ADA is the default now; dollars must be named.
 */
export function parseBackfillFlags(rest: string[]): { spacingSec: number | null; denomination: Denomination } {
  const out = { spacingSec: null as number | null, denomination: 'ada' as Denomination };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--currency') {
      const v = rest[i + 1];
      if (v !== 'ada' && v !== 'usd') throw new Error(`--currency must be ada or usd\n${USAGE}`);
      out.denomination = v; i++; continue;
    }
    if (flag === '--spacing-sec') {
      const n = Number(rest[i + 1]);
      if (rest[i + 1] === undefined || !Number.isFinite(n) || n < 0) throw new Error(`--spacing-sec needs a non-negative number of seconds\n${USAGE}`);
      out.spacingSec = n; i++;
    } else throw new Error(`unknown flag ${flag}\n${USAGE}`);
  }
  return out;
}

export async function backfillCommand(log: Logger, args: string[]): Promise<void> {
  const [ticker, fromArg, toArg, ...rest] = args;
  if (!ticker) throw new Error(USAGE);
  const { spacingSec, denomination } = parseBackfillFlags(rest);
  const from = parseIsoDate('from', fromArg);
  const to = parseIsoDate('to', toArg);
  const cfg = loadConfig(process.env, { blockfrost: false });
  const universe = await loadUniverse();
  const tokens = ticker === 'ALL' ? universe.tokens : universe.tokens.filter((t) => t.ticker === ticker);
  if (tokens.length === 0) throw new Error(`unknown ticker ${ticker}; not in universe.json`);
  const db = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'pg pool error'));
  try {
    await ensureTokens(db, universe);
    const client = new GeckoTerminalClient({ log, ...(spacingSec !== null ? { minSpacingMs: Math.round(spacingSec * 1000) } : {}) });
    const repo = new PgExternalRepo(db);
    const one = async (tk: string): Promise<BackfillRow> => {
      const token = universe.tokens.find((t) => t.ticker === tk)!;
      const callsBefore = client.calls();
      const r = await backfillToken({ client, repo, token, from, to, log, denomination });
      const cov = await repo.coverage(token.unit, denomination);
      const row: BackfillRow = { ticker: tk, pool: r.pool, method: r.method, pages: r.pages, newRows: r.rows, calls: client.calls() - callsBefore,
        coverageFirst: cov.first?.toISOString() ?? '-', coverageLast: cov.last?.toISOString() ?? '-', coverageRows: cov.rows };
      log.info(row, 'token backfilled');
      return row;
    };
    const { rows, failures } = await backfillAll(tokens, one, log);
    console.table(rows);
    if (failures.length) console.table(failures);
    console.log(`backfilled ${rows.length} of ${tokens.length} tokens, ${client.calls()} GeckoTerminal calls${failures.length ? `, ${failures.length} failed` : ''}; call spacing ended at ${client.currentSpacingMs()} ms`);
  } finally {
    await db.end();
  }
}
