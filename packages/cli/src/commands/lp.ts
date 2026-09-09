import { createPool } from '@ctb/db';
import { lpEntryRows, lpEntrySummary, type LpCandle, type LpEntryRow, type LpEntrySummary } from '@ctb/reports';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

/**
 * `lp <TICKER> [--since ISO] [--pool <pool_id>]`
 *
 * What a liquidity position would have been worth, for every entry tick in the observed window.
 * Read-only; safe to run while a paper run is live.
 *
 * No `--since` default, unlike `opportunity` and `leadlag`. Those exclude the laptop era because 22%
 * of its snapshots sit in the wrong time bucket, and a bucketing defect is indistinguishable from
 * volatility. Here the answer depends on the PRICES at two ticks, not on when they happened, so a
 * mislabelled `tick_ts` moves only the window length and the fee attribution. Excluding that era by
 * default would instead throw away every NIGHT candle we have.
 */
function arg(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const pad = (s: string, n: number): string => s.padEnd(n);
const signed = (n: number): string => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;

function entryLine(label: string, r: LpEntryRow): string {
  return `  ${pad(label, 8)} ${pad(r.entryTs.toISOString().slice(0, 16).replace('T', ' '), 17)}` +
    `${pad(Number(r.entryPrice).toFixed(6), 11)}${pad(signed(r.vsHoldTokensPct), 12)}${signed(r.breakEvenFeePct)}`;
}

/** Rendering kept apart from the numbers, so the numbers stay testable. */
export function renderLp(ticker: string, poolId: string, s: LpEntrySummary, days: number, otherPoolCandles: number): string[] {
  const out: string[] = [];
  out.push(`${ticker}  pool ${poolId}`);
  if (otherPoolCandles > 0) {
    // Not a filter for tidiness: liquidity is provided to ONE pool, and the collector's
    // deepest-per-tick policy splices venues, which would price a venue change as a market move.
    out.push(`  ${otherPoolCandles} candles on other pools EXCLUDED — an LP position sits in one pool`);
  }
  out.push(`  ${s.entries} possible entries over ${days.toFixed(1)} days, exit price ${Number(s.exitPrice).toFixed(6)}`);
  out.push('');
  out.push(`  ${pad('', 8)} ${pad('entry', 17)}${pad('price', 11)}${pad('vs holding', 12)}break-even fee`);
  out.push(entryLine('best', s.best));
  out.push(entryLine('median', s.median));
  out.push(entryLine('worst', s.worst));
  out.push('');
  out.push(`  ENTRY TIMING WAS WORTH ${s.spreadPct.toFixed(2)} POINTS across this window (best minus worst).`);
  out.push(`  Price alone; exact. Compare it against how far the price itself travelled before`);
  out.push(`  concluding that timing is or is not the lever.`);
  out.push('');
  const annualise = (pct: number): number => (days > 0 ? (pct * 365) / days : 0);
  const boundApr = annualise(s.median.feeLowerBoundPct);
  out.push(`  fees   at least ${s.median.feeLowerBoundPct.toFixed(4)}% earned since the median entry (${boundApr.toFixed(1)}% APR).`);
  out.push(`         That is a LOWER BOUND, from net reserve flow rather than volume: a buy and a sell`);
  out.push(`         inside one tick net to zero flow and pay two fees. Real income is higher by an`);
  out.push(`         unknown factor. It proves the pool earns at least this; it can never prove that`);
  out.push(`         an LP position loses.`);
  if (s.median.breakEvenFeePct > 0) {
    out.push(`         The median entry needs ${s.median.breakEvenFeePct.toFixed(2)}% (${annualise(s.median.breakEvenFeePct).toFixed(1)}% APR at this window's length) to match holding.`);
  } else {
    // A negative break-even is not a requirement to annualise. Rendered as an APR it read
    // "-367.9% APR", which looks like a catastrophic hurdle and means the exact opposite.
    out.push(`         The median entry is already ahead of holding by ${(-s.median.breakEvenFeePct).toFixed(2)}% before any fees,`);
    out.push(`         because the price fell: no fee income at all is needed to justify it over this window.`);
  }
  if (s.feeBpsAnomalies > 0) {
    out.push(`         ${s.feeBpsAnomalies} candle(s) carry fee_bps = 0 and contributed no fee to that bound.`);
  }
  return out;
}

export async function lpCommand(log: Logger, args: readonly string[]): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: false });
  const target = (args[0] && !args[0].startsWith('--') ? args[0] : '').toUpperCase();
  if (target === '') throw new Error('lp needs a ticker, e.g. `npm run lp -- NIGHT`');
  const since = arg(args, '--since') ?? '1970-01-01T00:00:00Z';
  const wantPool = arg(args, '--pool');

  const pool = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'lp pool error'));
  try {
    const rows = await pool.query<{ pool_id: string; tick_ts: Date; close: string; fee_bps: number; tvl_lovelace: string; net_flow_quote: string | null }>(
      `SELECT c.pool_id, c.tick_ts, c.close::text AS close, c.fee_bps,
              c.tvl_lovelace::text AS tvl_lovelace, c.net_flow_quote::text AS net_flow_quote
         FROM candles c JOIN tokens t ON t.unit = c.base_unit
        WHERE c.pool_id NOT LIKE 'Fake:%' AND t.ticker = $1 AND c.tick_ts >= $2::timestamptz
        ORDER BY c.tick_ts`,
      [target, since],
    );
    if (rows.rows.length === 0) {
      log.warn({ target, since }, 'no candles matched; nothing to measure');
      return;
    }

    const counts = new Map<string, number>();
    for (const r of rows.rows) counts.set(r.pool_id, (counts.get(r.pool_id) ?? 0) + 1);
    const chosen = wantPool ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    if (!counts.has(chosen)) throw new Error(`pool ${chosen} has no candles for ${target}; known: ${[...counts.keys()].join(', ')}`);

    const mine = rows.rows.filter((r) => r.pool_id === chosen);
    const candles: LpCandle[] = mine.map((r) => ({
      tickTs: r.tick_ts, close: r.close, feeBps: r.fee_bps,
      tvlLovelace: BigInt(r.tvl_lovelace),
      netFlowQuote: r.net_flow_quote === null ? null : BigInt(r.net_flow_quote),
    }));

    const summary = lpEntrySummary(lpEntryRows(candles));
    if (summary === null) {
      log.warn({ target, chosen, candles: candles.length }, 'not enough readable candles in one pool to measure an entry sweep');
      return;
    }
    const spanMs = candles[candles.length - 1]!.tickTs.getTime() - candles[0]!.tickTs.getTime();
    console.log('lp: what a liquidity position would have been worth, by entry tick\n');
    for (const line of renderLp(target, chosen, summary, spanMs / 86_400_000, rows.rows.length - mine.length)) console.log(line);
    console.log('');
    console.log('Impermanent loss depends ONLY on the ratio of exit price to entry price, and only on');
    console.log('the endpoints — a round trip through any path costs nothing at the exit. So no entry');
    console.log('price is intrinsically good; one is only near or far from an exit you cannot see yet.');
    console.log('`vs holding` is measured in TOKENS, which is the goal. The textbook IL number is the');
    console.log('same event measured against a 50/50 basket, and it is several times smaller.');
  } finally {
    await pool.end();
  }
}
