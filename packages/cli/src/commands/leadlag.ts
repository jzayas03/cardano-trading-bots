import { createPool } from '@ctb/db';
import { changesOf, crossCorrelation, interpret, MIN_SAMPLE, returnsOf, type LeadLagVerdict } from '@ctb/reports';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

/**
 * `leadlag [--max-lag N] [--since ISO]` — does on-chain structure move BEFORE price?
 *
 * Reads only candles this collector wrote, because only those carry `tvl_lovelace` and
 * `net_flow_*`; the GeckoTerminal backfill is OHLC alone.
 *
 * The default `--since` excludes everything before the M5 cutover on purpose. The candles from the
 * laptop era are quarantined: 22% of their snapshots sit in the wrong 10-minute bucket
 * (`docs/ops/2026-09-07-first-real-candles.md`), and a lead-lag study is ENTIRELY about timing, so
 * they would measure our own labelling defect rather than the market.
 */
const DEFAULT_SINCE = '2026-09-08T19:30:00Z';

function arg(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function describe(v: LeadLagVerdict): string {
  switch (v.kind) {
    case 'underpowered':
      return `underpowered  n=${v.n}, needs ${v.needed}`;
    case 'no signal':
      return `no signal     best |r|=${Math.abs(v.best.r).toFixed(3)} at lag ${v.best.lag} (needs ${v.threshold.toFixed(3)})`;
    case 'contemporaneous':
      return `SAME TIME     r=${v.best.r.toFixed(3)} at lag 0 — moves with price, not before it`;
    case 'price leads':
      return `PRICE LEADS   r=${v.best.r.toFixed(3)} at lag ${v.best.lag} — an echo, not a predictor`;
    case 'structure leads':
      return `LEADS by ${v.best.lag}   r=${v.best.r.toFixed(3)} (threshold ${v.threshold.toFixed(3)})`;
  }
}

export async function leadlagCommand(log: Logger, args: readonly string[]): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: false });
  const maxLag = Number(arg(args, '--max-lag') ?? 6);
  const since = arg(args, '--since') ?? DEFAULT_SINCE;
  if (!Number.isInteger(maxLag) || maxLag < 1) throw new Error('--max-lag must be a positive integer');

  const pool = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'leadlag pool error'));
  try {
    const rows = await pool.query<{ ticker: string | null; close: string; tvl: string | null; flow: string | null }>(
      `SELECT t.ticker, c.close::text AS close, c.tvl_lovelace::text AS tvl, c.net_flow_quote::text AS flow
         FROM candles c LEFT JOIN tokens t ON t.unit = c.base_unit
        WHERE c.pool_id NOT LIKE 'Fake:%' AND c.tick_ts >= $1::timestamptz
        ORDER BY c.base_unit, c.tick_ts`,
      [since],
    );

    const byToken = new Map<string, { close: number[]; tvl: number[]; flow: number[] }>();
    for (const r of rows.rows) {
      const k = r.ticker ?? '(unknown)';
      const s = byToken.get(k) ?? { close: [], tvl: [], flow: [] };
      s.close.push(Number(r.close));
      s.tvl.push(Number(r.tvl ?? 0));
      s.flow.push(Number(r.flow ?? 0));
      byToken.set(k, s);
    }

    // Every lag, for both metrics, for every token — the count the significance bar must widen for.
    const comparisons = (2 * maxLag + 1) * 2;
    console.log(`lead/lag since ${since}, max lag ${maxLag} candles, ${byToken.size} tokens`);
    console.log(`a correlation must clear a bar widened for ${comparisons} comparisons per token\n`);
    console.log(`${'token'.padEnd(8)} ${'n'.padEnd(5)} ${'TVL -> price'.padEnd(46)} flow -> price`);

    const rowsOut: string[] = [];
    for (const [ticker, s] of [...byToken].sort()) {
      const ret = returnsOf(s.close);
      const tvlV = interpret(crossCorrelation(changesOf(s.tvl), ret, maxLag), comparisons);
      const flowV = interpret(crossCorrelation(changesOf(s.flow), ret, maxLag), comparisons);
      rowsOut.push(`${ticker.padEnd(8)} ${String(ret.length).padEnd(5)} ${describe(tvlV).padEnd(46)} ${describe(flowV)}`);
    }
    console.log(rowsOut.join('\n'));

    const n = Math.max(0, ...[...byToken.values()].map((s) => s.close.length - 1));
    if (n < MIN_SAMPLE) {
      console.log(`\nEVERY ROW IS UNDERPOWERED. The most any token has is ${n} observations against ${MIN_SAMPLE}.`);
      console.log('This is the honest answer today, not a failure: the clean run began at the M5 cutover.');
      console.log(`At a 900s interval, ${MIN_SAMPLE} observations is about ${((MIN_SAMPLE * 900) / 86400).toFixed(1)} days. Re-run then.`);
    }
  } finally {
    await pool.end();
  }
}
