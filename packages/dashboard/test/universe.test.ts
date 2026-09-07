import type { TokenSpec } from '@ctb/universe';
import { describe, expect, it } from 'vitest';
import type { ExternalCoverage, TokenSnapshot } from '../src/reads.js';
import { renderUniverse, UNIVERSE_SORTS } from '../src/pages/universe.js';

const now = new Date('2026-09-07T18:00:00Z');
const NEWEST_TICK = new Date('2026-09-07T17:40:00Z');
const DAY_AGO_TICK = new Date('2026-09-06T17:40:00Z');

function token(overrides: Partial<TokenSpec>): TokenSpec {
  return {
    ticker: 'TOK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '544f4b',
    decimals: 6, category: 'DeFi', unit: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f544f4b',
    ...overrides,
  };
}

function snapshot(unit: string, overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    unit, dex: 'MinswapV2', poolId: 'MinswapV2:abcdefghijklmnop', tickTs: NEWEST_TICK,
    reserveBase: 1_000_000_000n, reserveQuote: 500_000_000n, feeBps: 30, tvlLovelace: 1_000_000_000n,
    ...overrides,
  };
}

const alpha = token({ ticker: 'ALPHA', unit: 'unit-alpha', decimals: 6 });
const beta = token({ ticker: 'BETA', unit: 'unit-beta', decimals: 0 });
const gamma = token({ ticker: 'GAMMA', unit: 'unit-gamma', decimals: 6 });

/**
 * Fix round, IMPORTANT 3: the `?sort=change` test below only ever checked which row came first —
 * nothing anywhere asserted that a real, non-zero change actually renders as the number it is
 * (e.g. `100` for a doubling), only that rows with a change value sort ahead of rows without one. This
 * pulls one row's own `<td>` cells out by ticker, in column order (`COLUMNS` in `pages/universe.ts`:
 * rank, ticker, venue, pool, depth, price, change, ext rows, ext first, ext last, note), so the value
 * assertions below can pin the "24h change %" cell (index 6) to its exact rendered text rather than
 * merely its position on the page.
 */
function rowCellsFor(html: string, ticker: string): string[] {
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => m[1] ?? '');
  const row = rows.find((r) => r.includes(`>${ticker}<`));
  if (row === undefined) throw new Error(`no <tr> found containing >${ticker}<`);
  return [...row.matchAll(/<td>(.*?)<\/td>/g)].map((m) => m[1] ?? '');
}

describe('renderUniverse', () => {
  it('renders exactly one row per universe token, in universe order by default (sort: rank)', () => {
    const tokens = [alpha, beta, gamma];
    const html = renderUniverse({ tokens, latest: [], dayAgo: [], coverage: [], sort: 'rank', now });
    const idx = (t: string) => html.indexOf(`>${t}<`);
    expect(idx('ALPHA')).toBeGreaterThan(-1);
    expect(idx('BETA')).toBeGreaterThan(idx('ALPHA'));
    expect(idx('GAMMA')).toBeGreaterThan(idx('BETA'));
  });

  it('the rank column is the token\'s universe position + 1, in order', () => {
    const tokens = [alpha, beta, gamma];
    const html = renderUniverse({ tokens, latest: [], dayAgo: [], coverage: [], sort: 'rank', now });
    // rank is the FIRST <td> of each <tr> — anchored to <tr><td> so it can't be confused with a
    // later numeric cell in the same row (e.g. "ext rows", which is also a bare digit).
    const ranks = [...html.matchAll(/<tr><td>(\d+)<\/td>/g)].map((m) => Number(m[1]));
    expect(ranks).toEqual([1, 2, 3]);
  });

  it('a token with no row in `latest` renders "-" for venue/pool/depth/price/change and a note that the collector has no snapshot for it', () => {
    const html = renderUniverse({ tokens: [alpha], latest: [], dayAgo: [], coverage: [], sort: 'rank', now });
    expect(html).toContain('no collector snapshot for this token on the newest tick');
    // Every measured column for the one row is a dash — count the dash cells (rank/ticker/coverage-rows
    // are never dashes, so this is a floor, not an exact count, but a token with zero data should have
    // several dash cells, not zero).
    const dashCount = (html.match(/<td>-<\/td>/g) ?? []).length;
    expect(dashCount).toBeGreaterThanOrEqual(6); // venue, pool, depth, price, change, ext first, ext last
  });

  it('a token with a `latest` row but no `dayAgo` row renders "-" for change only', () => {
    const latest = [snapshot(alpha.unit)];
    const html = renderUniverse({ tokens: [alpha], latest, dayAgo: [], coverage: [], sort: 'rank', now });
    expect(html).toContain('MinswapV2');
    expect(html).toContain('<td>500.000000</td>'); // adaStr(500_000_000n)
    expect(html).not.toContain('no collector snapshot for this token on the newest tick');
    // The row has real depth/price data but the change column is still a dash.
    expect(html).toMatch(/<td>-<\/td>\s*<td>0<\/td>/); // change dash, then "0" ext rows
  });

  it('a token with no coverage row renders 0 rows and "-" dates, never a blank or a crash', () => {
    const latest = [snapshot(alpha.unit)];
    const dayAgo = [snapshot(alpha.unit, { tickTs: DAY_AGO_TICK })];
    const html = renderUniverse({ tokens: [alpha], latest, dayAgo, coverage: [], sort: 'rank', now });
    expect(html).toContain('<td>0</td>'); // ext rows
    const dashCount = (html.match(/<td>-<\/td>/g) ?? []).length;
    expect(dashCount).toBe(2); // ext first, ext last only
  });

  it('pool id is shortened to its LAST 12 characters, with the full id in a title attribute', () => {
    // Fix round, finding 4: every real pool id is "<dex>:" + 128 hex characters, so truncating the
    // first 12 characters of the raw id showed "MinswapV2:ab" on every single row — ten of those twelve
    // characters are just the venue name, already shown one column over. Stripping the "<dex>:" label
    // alone is STILL not enough: a live check against the real dev database (Step 5's own
    // verification, see this function's own header comment) found every pool id also shares a long
    // common script-hash prefix immediately after the label (the DEX's own validator script, identical
    // for every pool of that DEX version) — only the LAST 12 characters (the pool-specific staking
    // credential) actually differ row to row.
    const latest = [snapshot(alpha.unit, { poolId: 'MinswapV2:abcdefghijklmnopqrstuvwxyz' })];
    const html = renderUniverse({ tokens: [alpha], latest, dayAgo: [], coverage: [], sort: 'rank', now });
    expect(html).toContain('<span title="MinswapV2:abcdefghijklmnopqrstuvwxyz">opqrstuvwxyz</span>');
  });

  it('a short pool id (under 12 characters) renders in full, never crashing or padding', () => {
    const latest = [snapshot(alpha.unit, { poolId: 'short' })];
    const html = renderUniverse({ tokens: [alpha], latest, dayAgo: [], coverage: [], sort: 'rank', now });
    expect(html).toContain('<span title="short">short</span>');
  });

  it('every ticker links to /runs?ticker=<ticker>', () => {
    const html = renderUniverse({ tokens: [alpha], latest: [], dayAgo: [], coverage: [], sort: 'rank', now });
    expect(html).toContain('<a href="/runs?ticker=ALPHA">ALPHA</a>');
  });

  describe('sorting', () => {
    const tokens = [alpha, beta, gamma]; // universe (rank) order: alpha, beta, gamma

    it('?sort=ticker orders alphabetically, even when that differs from universe/rank order', () => {
      // Universe order is deliberately NOT alphabetical here (gamma, alpha, beta), so a pass only
      // proves sort=ticker actually reordered — sort=rank on this same input would read gamma first.
      const scrambled = [gamma, alpha, beta];
      const html = renderUniverse({ tokens: scrambled, latest: [], dayAgo: [], coverage: [], sort: 'ticker', now });
      const idx = (t: string) => html.indexOf(`>${t}<`);
      expect(idx('ALPHA')).toBeLessThan(idx('BETA'));
      expect(idx('BETA')).toBeLessThan(idx('GAMMA'));
    });

    it('?sort=depth orders descending, with a token missing from `latest` sorted LAST, never treated as zero or floated to the top', () => {
      const latest = [
        snapshot(alpha.unit, { reserveQuote: 100n }),
        snapshot(gamma.unit, { reserveQuote: 900n }),
        // beta has no snapshot at all
      ];
      const html = renderUniverse({ tokens, latest, dayAgo: [], coverage: [], sort: 'depth', now });
      const idx = (t: string) => html.indexOf(`>${t}<`);
      expect(idx('GAMMA')).toBeLessThan(idx('ALPHA')); // 900 before 100
      expect(idx('ALPHA')).toBeLessThan(idx('BETA')); // present before absent
    });

    it('?sort=change orders descending, with a token that has no `dayAgo` price sorted LAST', () => {
      const latest = [
        snapshot(alpha.unit, { reserveQuote: 100_000_000n }), // then 100, now 100 -> 0%
        snapshot(beta.unit, { reserveQuote: 200_000_000n }), // then 100, now 200 -> +100%
        snapshot(gamma.unit, { reserveQuote: 100_000_000n }), // no dayAgo row -> absent, must sort last
      ];
      const dayAgo = [
        snapshot(alpha.unit, { reserveQuote: 100_000_000n, tickTs: DAY_AGO_TICK }),
        snapshot(beta.unit, { reserveQuote: 100_000_000n, tickTs: DAY_AGO_TICK }),
      ];
      const html = renderUniverse({ tokens, latest, dayAgo, coverage: [], sort: 'change', now });
      const idx = (t: string) => html.indexOf(`>${t}<`);
      expect(idx('BETA')).toBeLessThan(idx('ALPHA')); // +100% before 0%
      expect(idx('ALPHA')).toBeLessThan(idx('GAMMA')); // present (0%) before absent

      // The ordering above only proves relative position; nothing yet proves the change COLUMN itself
      // (index 6: rank, ticker, venue, pool, depth, price, change, ...) actually shows the real
      // percentage rather than, say, a placeholder or the wrong figure entirely. A present value
      // renders as `<span title="baseline tick: ...">N</span>` (finding 5: the baseline tick lives in
      // the title), so these check the cell's rendered TEXT content, not the raw `<td>` body.
      expect(rowCellsFor(html, 'BETA')[6]).toContain('>100<'); // then 100, now 200 -> +100%
      expect(rowCellsFor(html, 'BETA')[6]).toContain(`title="baseline tick: ${DAY_AGO_TICK.toISOString()}"`);
      expect(rowCellsFor(html, 'ALPHA')[6]).toContain('>0<'); // then 100, now 100 -> unchanged, a real 0, not absence
      expect(rowCellsFor(html, 'GAMMA')[6]).toBe('-'); // no dayAgo row -> absence, never a computed 0
    });

    it('?sort=coverage orders by external row count descending', () => {
      const coverage: ExternalCoverage[] = [
        { unit: alpha.unit, rows: 5, first: DAY_AGO_TICK, last: NEWEST_TICK },
        { unit: gamma.unit, rows: 50, first: DAY_AGO_TICK, last: NEWEST_TICK },
        // beta has no coverage row at all -> reads as 0, sorts last
      ];
      const html = renderUniverse({ tokens, latest: [], dayAgo: [], coverage, sort: 'coverage', now });
      const idx = (t: string) => html.indexOf(`>${t}<`);
      expect(idx('GAMMA')).toBeLessThan(idx('ALPHA')); // 50 before 5
      expect(idx('ALPHA')).toBeLessThan(idx('BETA')); // 5 before 0
    });
  });

  it('the explanatory line names the newest collector tick and explains what depth/price/change mean', () => {
    const latest = [snapshot(alpha.unit)];
    const html = renderUniverse({ tokens: [alpha], latest, dayAgo: [], coverage: [], sort: 'rank', now });
    expect(html).toContain(NEWEST_TICK.toISOString());
    expect(html).toContain('deepest pool');
    expect(html).toContain('24 hours');
  });

  it('says so when no collector snapshot has been recorded at all', () => {
    const html = renderUniverse({ tokens: [alpha], latest: [], dayAgo: [], coverage: [], sort: 'rank', now });
    expect(html).toContain('no collector snapshot has been recorded yet');
  });

  it('UNIVERSE_SORTS names exactly the five accepted sort values', () => {
    expect(UNIVERSE_SORTS).toEqual(['rank', 'ticker', 'depth', 'change', 'coverage']);
  });
});
