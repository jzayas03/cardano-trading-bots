import { createPool } from '@ctb/db';
import { DEFAULT_FLOOR_BPS, opportunity, type OpportunityCandle, type OpportunityReport } from '@ctb/reports';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';

/**
 * `opportunity [TICKER|ALL] [--since ISO] [--floor-bps N] [--windows 1800,7200,86400]`
 *
 * Does the price move more than it costs to trade? Read-only; safe to run while a paper run is live.
 *
 * Reads only candles this collector wrote. The GeckoTerminal backfill is OHLC from trades and has no
 * snapshot behind it, so its candles cannot be told apart from single-sample ones and would be
 * counted as "not measurable" -- true, but noise.
 *
 * `--since` defaults to the M5 cutover for the same reason `leadlag` does: 22% of the laptop era's
 * snapshots sit in the wrong bucket, and a bucketing defect is indistinguishable from volatility
 * here. Those candles are also all single-sample, so they would land in `notMeasurable` anyway --
 * the default just keeps them out of the count.
 */
const DEFAULT_SINCE = '2026-09-08T19:30:00Z';
const DEFAULT_WINDOWS = [1_800, 7_200, 86_400];

function arg(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fmt(n: number | null, digits = 1, suffix = ''): string {
  return n === null ? '--' : `${n.toFixed(digits)}${suffix}`;
}

function humanWindow(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${seconds / 60}m`;
}

/** Rendering kept separate from the numbers so the numbers stay testable. */
export function renderOpportunity(ticker: string, r: OpportunityReport): string[] {
  const i = r.intraCandle;
  const out: string[] = [];
  out.push(`${ticker}  ${r.candles} candles, floor ${r.floorBps} bps (${(r.floorBps / 100).toFixed(2)}% round trip)`);
  if (i.measurable === 0) {
    // Never print a 0% here. Every candle written before tiered sampling has one sample and a range
    // of zero BY CONSTRUCTION; "0% clear the floor" would read as "no opportunity" rather than
    // "nothing was measured".
    out.push(`  intra-candle   NOT MEASURED -- all ${i.notMeasurable} candles have one sample, so high = low by construction`);
  } else {
    out.push(
      `  intra-candle   ${fmt(i.pctClearing, 1, '%')} of ${i.measurable} clear the floor` +
      `   median ${fmt(i.medianRangeBps, 0)} bps, p90 ${fmt(i.p90RangeBps, 0)} bps` +
      (i.notMeasurable > 0 ? `   (${i.notMeasurable} single-sample candles excluded)` : ''),
    );
    out.push(`  missed by close-only   ${i.missedByCloseOnly} candles cleared the floor on range but not open-to-close`);
  }
  for (const w of r.windows) {
    out.push(
      `  ${humanWindow(w.seconds).padEnd(4)} windows   ${fmt(w.pctClearing, 1, '%')} of ${w.windows} clear` +
      `   median |move| ${fmt(w.medianAbsBps, 0)} bps` +
      (w.skippedForGaps > 0 ? `   (${w.skippedForGaps} skipped for gaps)` : ''),
    );
  }
  return out;
}

export async function opportunityCommand(log: Logger, args: readonly string[]): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: false });
  const target = (args[0] && !args[0].startsWith('--') ? args[0] : 'ALL').toUpperCase();
  const since = arg(args, '--since') ?? DEFAULT_SINCE;
  const floorBps = Number(arg(args, '--floor-bps') ?? DEFAULT_FLOOR_BPS);
  const windowSecs = (arg(args, '--windows')?.split(',').map((s) => Number(s.trim())) ?? DEFAULT_WINDOWS);
  if (!Number.isFinite(floorBps) || floorBps <= 0) throw new Error('--floor-bps must be a positive number');
  if (windowSecs.some((w) => !Number.isInteger(w) || w <= 0)) throw new Error('--windows must be positive integers (seconds)');

  const pool = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'opportunity pool error'));
  try {
    // `samples` counts snapshots for the candle's OWN pool inside its own bucket. `buildCandles`
    // takes every price from the deepest pool in the bucket and ignores the rest, so counting across
    // pools would claim a range was measured from samples that never fed it.
    const rows = await pool.query<{ ticker: string | null; tick_ts: Date; open: string; high: string; low: string; close: string; samples: string }>(
      `SELECT t.ticker,
              c.tick_ts,
              c.open::text  AS open,
              c.high::text  AS high,
              c.low::text   AS low,
              c.close::text AS close,
              (SELECT count(*) FROM pool_snapshots s
                WHERE s.pool_id = c.pool_id
                  AND s.base_unit = c.base_unit
                  AND s.tick_ts >= c.tick_ts
                  AND s.tick_ts <  c.tick_ts + make_interval(secs => $2::int)) AS samples
         FROM candles c
         JOIN tokens t ON t.unit = c.base_unit
        WHERE c.pool_id NOT LIKE 'Fake:%'
          AND c.tick_ts >= $1::timestamptz
          AND ($3 = 'ALL' OR t.ticker = $3)
        ORDER BY t.ticker, c.tick_ts`,
      [since, cfg.intervalSec, target],
    );

    if (rows.rows.length === 0) {
      log.warn({ since, target }, 'no candles matched; nothing to measure');
      return;
    }

    const byToken = new Map<string, OpportunityCandle[]>();
    for (const r of rows.rows) {
      const ticker = r.ticker ?? 'unknown';
      const list = byToken.get(ticker) ?? [];
      list.push({
        tickTs: r.tick_ts,
        open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
        samples: Number(r.samples),
      });
      byToken.set(ticker, list);
    }

    console.log(`opportunity: does the price move more than the ${(floorBps / 100).toFixed(2)}% round-trip cost floor?`);
    console.log(`since ${since}, candle interval ${cfg.intervalSec}s\n`);
    for (const [ticker, candles] of [...byToken.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      for (const line of renderOpportunity(ticker, opportunity(candles, { floorBps, candleIntervalSec: cfg.intervalSec, windowSecs }))) {
        console.log(line);
      }
      console.log('');
    }
    console.log('Moves of sufficient size EXISTING is a necessary condition, not a sufficient one.');
    console.log('Whether a strategy captures them is what the paper runs measure.');
  } finally {
    await pool.end();
  }
}
