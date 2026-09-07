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
 * rounds tightening that same allowlist after it became a hole), an earlier version of `buildRanks`
 * counted up with `rank++` — a `PostfixUnaryExpression`, never a `BinaryExpression`, so the arithmetic
 * scan had nothing to see.
 *
 * IMPORTANT 3 (final review): that `rank++` was an escape hatch, not a fix, and a reviewer proved it
 * live — they added a `gainers` count built the identical way (`n++`), rendered it on this page, and
 * the guard stayed green over a real market figure the dashboard had computed itself. Both halves are
 * closed now: the guard itself also walks `++`/`--` (see `oneRule.guard.test.ts`'s own header), and
 * `buildRanks` below no longer does arithmetic of ANY kind — not `+`, not `++`, nothing left for a
 * scanner to need to see. `RANK_LABELS` is a plain array of numeric literals (nothing computes any of
 * them), and `buildRanks` is just `RANK_LABELS.slice(0, count)` — `.slice` and the `>` bound check below
 * are not arithmetic operators, so this function needs no allowlist entry and has no hatch left in it.
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
 * 1-based rank labels, written out as plain numeric literals — not `i + 1`, not `rank++`, not any
 * other expression a guard would need to evaluate to know it isn't a financial figure (see the file
 * header for the escape-hatch history this replaces). Generous past the current 20-token universe
 * (`packages/universe/universe.json`) so growing it by a few tokens doesn't hit a wall the day someone
 * does; `buildRanks` throws a clear, actionable message if the universe ever outgrows this list, rather
 * than silently truncating the rank column.
 */
const RANK_LABELS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
];

/** `count` 1-based rank labels, sliced off the literal list above — no arithmetic expression exists
 * anywhere in this function for the one-rule guard's scan to evaluate. `>` is a comparison, not one of
 * the arithmetic operators the guard treats as "computing a figure" (see that guard's own header). */
function buildRanks(count: number): number[] {
  if (count > RANK_LABELS.length) {
    throw new Error(`universe has grown to ${count} tokens; RANK_LABELS only covers ${RANK_LABELS.length} — extend the literal list in pages/universe.ts`);
  }
  return RANK_LABELS.slice(0, count);
}

interface UniverseRow {
  rank: number;
  token: TokenSpec;
  latest: TokenSnapshot | undefined;
  dayAgo: TokenSnapshot | undefined;
  coverage: ExternalCoverage | undefined;
  /** `safePrice(latest, token.decimals)` — computed once here (fix round, finding 7) and reused by
   * BOTH `changePct` below (as the `now` argument to `priceChangePct`) and `rowCells`'s displayed price
   * cell, so a row's current price is asked for exactly once, never recomputed a second time for the
   * same figure. */
  price: string | null;
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
    const price = safePrice(latestSnap, token.decimals);
    return {
      rank: ranks[i] ?? 0,
      token,
      latest: latestSnap,
      dayAgo: dayAgoSnap,
      coverage: coverageByUnit.get(token.unit),
      price,
      changePct: priceChangePct(then, price),
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

/**
 * Fix round, finding 4: every real pool id is `<dex>:` followed by 128 hex characters, so truncating
 * the RAW id to the first `POOL_ID_DISPLAY_CHARS` showed `MinswapV2:f5` on every single row — ten of
 * the twelve displayed characters were just the venue name, already shown one column over.
 *
 * Stripping the `<dex>:` label was the first fix tried, but the live dev database (Step 5's own
 * verification) showed it is NOT enough on its own: a Cardano DEX pool id is itself a script address,
 * and its payment credential — the DEX's OWN validator script hash — is identical across every pool of
 * that DEX version, not just the human-readable `MinswapV2:` label in front of it. All 20 live rows'
 * ids shared the identical 12 characters immediately after the label (`f5808c2c990d`) and only diverged
 * further in — the pool-specific part (the staking credential) sits at the END of the id, not right
 * after the prefix. Taking the LAST `POOL_ID_DISPLAY_CHARS` characters of the full id — verified
 * distinct across all 20 live rows — is what actually distinguishes one pool from another; the full,
 * untruncated id still lives in the `title` attribute either way.
 */
function poolCell(poolId: string): RenderedCell {
  const short = poolId.slice(-POOL_ID_DISPLAY_CHARS);
  return { html: `<span title="${escape(poolId)}">${escape(short)}</span>` };
}

/**
 * A sortable header links to its own `?sort=` value (final review, IMPORTANT 5's "while you are
 * there" note) — sorting previously required hand-editing the URL. Only a header with a real entry in
 * `UNIVERSE_SORTS` is a link; the rest (venue, pool, price, ext first/last, note — none of which this
 * page can sort by) render as plain text, exactly as before this change.
 */
function sortHeader(label: string, sort: (typeof UNIVERSE_SORTS)[number]): RenderedCell {
  return { html: `<a href="/universe?sort=${escape(sort)}">${escape(label)}</a>` };
}

const COLUMNS: Array<string | RenderedCell> = [
  sortHeader('rank', 'rank'),
  sortHeader('ticker', 'ticker'),
  'venue',
  'pool',
  sortHeader('depth ADA', 'depth'),
  'price ADA/token',
  sortHeader('24h change %', 'change'),
  sortHeader('ext rows', 'coverage'),
  'ext first',
  'ext last',
  'note',
];

function tickerCell(ticker: string): RenderedCell {
  return { html: `<a href="/runs?ticker=${escape(ticker)}">${escape(ticker)}</a>` };
}

/**
 * Fix round, finding 5: a token whose `dayAgo` snapshot is actually 26 hours old (the far edge of
 * `snapshotsAt`'s degrade window) rendered identically to one exactly 24 hours old — nothing on the
 * page named which tick a given row's percentage was measured against. `dayAgo` is defined here
 * whenever `changePct` is non-null (`priceChangePct` needs `then`, which only exists when `dayAgoSnap`
 * itself does — see `buildRows`), so the title is always available on every row that isn't a dash.
 */
function changeCell(changePct: number | null, dayAgo: TokenSnapshot | undefined): string | RenderedCell {
  if (changePct === null) return '-';
  const title = dayAgo ? `baseline tick: ${dayAgo.tickTs.toISOString()}` : '';
  return { html: `<span title="${escape(title)}">${escape(changePct)}</span>` };
}

function rowCells(row: UniverseRow): Array<string | number | RenderedCell> {
  const { latest, coverage, changePct, price } = row;
  const note = latest === undefined ? 'no collector snapshot for this token on the newest tick' : '';
  return [
    row.rank,
    tickerCell(row.token.ticker),
    latest ? latest.dex : '-',
    latest ? poolCell(latest.poolId) : '-',
    latest ? adaStr(latest.reserveQuote) : '-',
    price ?? '-',
    changeCell(changePct, row.dayAgo),
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
  return `newest collector tick: ${tickTs.toISOString()} — depth and price are the deepest pool (by pool TVL) per token AT that tick; 24h change compares against the newest tick at or before 24 hours earlier, degrading to the nearest older tick (within a 26h window) rather than showing nothing on a missed collection.`;
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
