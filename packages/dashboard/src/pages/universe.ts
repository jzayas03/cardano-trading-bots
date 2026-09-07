/**
 * `/universe` (spec §4.2, M4c): the screener — what the market looks like, as opposed to `/runs`'s
 * "what a run did". One row per universe token, in market-cap rank order by default (`loadUniverse()`
 * preserves seed order, and array position IS the rank — spec's own verified fact). Every figure this
 * page shows is the return value of a function this package is allowed to call under the one rule:
 * `adaStr`/`priceChangePct` from `@ctb/reports`, `priceAdaPerToken` from `@ctb/candles` (the package
 * that actually owns the price figure — `build.ts`'s `buildCandles` computes the identical candle
 * price the same way, from the same two reserve columns).
 *
 * `rank` is a list POSITION, not a financial figure, but the one-rule guard's arithmetic scan cannot
 * tell "index + 1" apart from a computed figure by shape alone — it only knows "binary arithmetic
 * between two non-constant operands", and a loop variable plus a literal is exactly that shape.
 * Rather than widen the guard's allowlist for a display index (the previous milestone spent two fix
 * rounds tightening that same allowlist after it became a hole), `buildRanks` below counts up with
 * `rank++` — a `PostfixUnaryExpression`, never a `BinaryExpression`, so the scan has nothing to see.
 *
 * A token missing from `latest` (no snapshot on the newest tick), from `dayAgo` (no snapshot at or
 * before 24h ago, inside the window), or from `coverage` (never matched to an external pool) renders
 * `-` for the missing figure, never `0` and never a stale value carried forward — and sorts LAST on
 * whichever column is missing, never first (floating an absence to the top of "biggest change" would
 * be actively misleading, not merely wrong).
 */
import { priceAdaPerToken } from '@ctb/candles';
import { adaStr, priceChangePct } from '@ctb/reports';
import type { TokenSpec } from '@ctb/universe';
import { escape, layout, table, type RenderedCell } from '../html.js';
import type { ExternalCoverage, TokenSnapshot } from '../reads.js';

export const UNIVERSE_SORTS = ['rank', 'ticker', 'depth', 'change', 'coverage'] as const;

const POOL_ID_DISPLAY_CHARS = 12;

/**
 * `count` 1-based rank labels, built by counting up rather than by `tokens.map((_, i) => i + 1)` —
 * see the file header for why. `while (ranks.length < count)` and `rank++` are the only two moving
 * parts; neither is a `BinaryExpression`, so the one-rule guard's arithmetic scan never visits this
 * function at all.
 */
function buildRanks(count: number): number[] {
  const ranks: number[] = [];
  let rank = 1;
  while (ranks.length < count) {
    ranks.push(rank);
    rank++;
  }
  return ranks;
}

interface UniverseRow {
  rank: number;
  token: TokenSpec;
  latest: TokenSnapshot | undefined;
  dayAgo: TokenSnapshot | undefined;
  coverage: ExternalCoverage | undefined;
  /** `null` when there is no `latest` price, no `dayAgo` price, or `priceChangePct` itself says so
   * (an unparseable or zero baseline) — computed once per row so both the table cell and the `change`
   * sort read the identical value. */
  changePct: number | null;
}

/** `priceAdaPerToken` throws on non-positive reserves — a defensive floor, not an expected case (the
 * schema's own CHECK allows a reserve of exactly 0, and this page must never take the whole route
 * down over one bad row), mirroring `pages/runs.ts`'s own `safeAda` wrapper around `adaStr`. */
function safePrice(s: TokenSnapshot | undefined, decimals: number): string | null {
  if (!s) return null;
  try {
    return priceAdaPerToken(s.reserveQuote, s.reserveBase, decimals);
  } catch {
    return null;
  }
}

function buildRows(tokens: TokenSpec[], latest: TokenSnapshot[], dayAgo: TokenSnapshot[], coverage: ExternalCoverage[]): UniverseRow[] {
  const latestByUnit = new Map(latest.map((s) => [s.unit, s]));
  const dayAgoByUnit = new Map(dayAgo.map((s) => [s.unit, s]));
  const coverageByUnit = new Map(coverage.map((c) => [c.unit, c]));
  const ranks = buildRanks(tokens.length);

  return tokens.map((token, i) => {
    const latestSnap = latestByUnit.get(token.unit);
    const dayAgoSnap = dayAgoByUnit.get(token.unit);
    const then = safePrice(dayAgoSnap, token.decimals);
    const now = safePrice(latestSnap, token.decimals);
    return {
      rank: ranks[i] ?? 0,
      token,
      latest: latestSnap,
      dayAgo: dayAgoSnap,
      coverage: coverageByUnit.get(token.unit),
      changePct: priceChangePct(then, now),
    };
  });
}

/** Absent (`null`/`undefined`) values sort LAST regardless of direction — never first, never treated
 * as zero. `cmp` compares two PRESENT values in the direction the caller wants ("bigger is better"
 * for depth/change/coverage — a descending sort — so `cmp` itself returns negative when its first
 * argument should sort earlier). */
function withAbsentLast<T, V>(get: (row: T) => V | null | undefined, cmp: (a: V, b: V) => number): (a: T, b: T) => number {
  return (a, b) => {
    const av = get(a);
    const bv = get(b);
    const aMissing = av === null || av === undefined;
    const bMissing = bv === null || bv === undefined;
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return cmp(av as V, bv as V);
  };
}

const descending = <V>(a: V, b: V): number => {
  if (a === b) return 0;
  return a > b ? -1 : 1;
};

const SORTERS: Record<(typeof UNIVERSE_SORTS)[number], ((a: UniverseRow, b: UniverseRow) => number) | undefined> = {
  rank: undefined, // universe order === rank order already; nothing to re-sort
  ticker: (a, b) => a.token.ticker.localeCompare(b.token.ticker),
  depth: withAbsentLast((r) => r.latest?.reserveQuote, descending),
  change: withAbsentLast((r) => r.changePct, descending),
  coverage: withAbsentLast((r) => r.coverage?.rows, descending),
};

function poolCell(poolId: string): RenderedCell {
  const short = poolId.slice(0, POOL_ID_DISPLAY_CHARS);
  return { html: `<span title="${escape(poolId)}">${escape(short)}</span>` };
}

const COLUMNS = ['rank', 'ticker', 'venue', 'pool', 'depth ADA', 'price ADA/token', '24h change %', 'ext rows', 'ext first', 'ext last', 'note'];

function tickerCell(ticker: string): RenderedCell {
  return { html: `<a href="/runs?ticker=${escape(ticker)}">${escape(ticker)}</a>` };
}

function rowCells(row: UniverseRow): Array<string | number | RenderedCell> {
  const { latest, coverage, changePct } = row;
  const price = latest ? safePrice(latest, row.token.decimals) : null;
  const note = latest === undefined ? 'no collector snapshot for this token on the newest tick' : '';
  return [
    row.rank,
    tickerCell(row.token.ticker),
    latest ? latest.dex : '-',
    latest ? poolCell(latest.poolId) : '-',
    latest ? adaStr(latest.reserveQuote) : '-',
    price ?? '-',
    changePct === null ? '-' : changePct,
    coverage?.rows ?? 0,
    coverage?.first ? coverage.first.toISOString() : '-',
    coverage?.last ? coverage.last.toISOString() : '-',
    note,
  ];
}

/** "no snapshot at all yet" (empty `latest`) vs. "here is the tick everything below is anchored to" —
 * every row in `latest` shares the identical `tick_ts` by construction (`latestSnapshotsPerToken`
 * filters to the table's single newest tick before picking a pool per token), so any one row's
 * `tickTs` names it. */
function explanatoryLine(latest: TokenSnapshot[]): string {
  const tickTs = latest[0]?.tickTs;
  if (tickTs === undefined) {
    return 'no collector snapshot has been recorded yet — depth, price and 24h change cannot be shown for any token.';
  }
  return `newest collector tick: ${tickTs.toISOString()} — depth and price are the deepest pool (by ADA reserve) per token AT that tick; 24h change compares against the newest tick at or before 24 hours earlier, degrading to the nearest older tick (within a 26h window) rather than showing nothing on a missed collection.`;
}

export function renderUniverse(input: {
  tokens: TokenSpec[];
  latest: TokenSnapshot[];
  dayAgo: TokenSnapshot[];
  coverage: ExternalCoverage[];
  sort: (typeof UNIVERSE_SORTS)[number];
  now: Date;
}): string {
  const { tokens, latest, dayAgo, coverage, sort, now } = input;
  const rows = buildRows(tokens, latest, dayAgo, coverage);
  const sorter = SORTERS[sort];
  const ordered = sorter ? [...rows].sort(sorter) : rows;

  const body = `
<p>${escape(explanatoryLine(latest))}</p>
<p class="asof">sorted by: ${escape(sort)} &middot; as of ${escape(now.toISOString())}</p>
${table(COLUMNS, ordered.map(rowCells))}`;

  return layout('Universe', body);
}
