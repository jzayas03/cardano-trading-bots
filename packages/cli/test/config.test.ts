import { describe, expect, it } from 'vitest';
import { DEFAULT_VENUES, VENUE_NAMES } from '@ctb/collector';
import { deriveDashboardUrl, loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://ctb:x@localhost:5433/ctb' };
const dashboardDatabaseUrl = deriveDashboardUrl(base.DATABASE_URL);

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base, { blockfrost: false });
    expect(c).toEqual({
      databaseUrl: base.DATABASE_URL, dashboardDatabaseUrl, blockfrostProjectId: null, intervalSec: 600, logLevel: 'info',
      venues: DEFAULT_VENUES, refreshPolicy: 'deepest',
    });
  });

  it('requires BLOCKFROST_PROJECT_ID only when asked', () => {
    expect(() => loadConfig(base, { blockfrost: true })).toThrow(/BLOCKFROST_PROJECT_ID/);
    expect(loadConfig({ ...base, BLOCKFROST_PROJECT_ID: 'mainnetabc' }, { blockfrost: true }).blockfrostProjectId).toBe('mainnetabc');
  });

  it('rejects a non-integer or too-short interval', () => {
    expect(() => loadConfig({ ...base, COLLECT_INTERVAL_SECONDS: 'soon' }, { blockfrost: false })).toThrow(/COLLECT_INTERVAL_SECONDS/);
    expect(() => loadConfig({ ...base, COLLECT_INTERVAL_SECONDS: '10' }, { blockfrost: false })).toThrow(/COLLECT_INTERVAL_SECONDS/);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({}, { blockfrost: false })).toThrow(/DATABASE_URL/);
  });

  it('pins an empty BLOCKFROST_PROJECT_ID as absent, not a validation failure', () => {
    // .env.example ships a bare `BLOCKFROST_PROJECT_ID=` line, which dotenv loads as ''.
    // Commands that don't need Blockfrost must still succeed; commands that do must still
    // fail closed and name the variable, exactly as when it's unset.
    expect(loadConfig({ ...base, BLOCKFROST_PROJECT_ID: '' }, { blockfrost: false })).toEqual({
      databaseUrl: base.DATABASE_URL,
      dashboardDatabaseUrl,
      blockfrostProjectId: null,
      intervalSec: 600,
      logLevel: 'info',
      venues: DEFAULT_VENUES,
      refreshPolicy: 'deepest',
    });
    expect(() => loadConfig({ ...base, BLOCKFROST_PROJECT_ID: '' }, { blockfrost: true })).toThrow(
      /BLOCKFROST_PROJECT_ID/,
    );
  });

  it('defaults venues to exactly the six enabledByDefault, discoverable venues', () => {
    // VyFinance/Splash: excluded because Dexter can't discover them at all (VyFinance's
    // liquidityPools() is a hardcoded rejection; Splash's Dexter 5.4.10 bug never returns a pool —
    // see venues.ts's header comment). Minswap v1: excluded because it is `enabledByDefault: false`
    // — run 50 (2026-09-06, real key, mainnet) measured ~9,600 discovery calls/day for 14 shallow
    // pools that are never the deepest pool for their token except AGIX (the deepest pool per token
    // is on Minswap v2 for 19/20 tokens), so refreshing them spends quota the candle pipeline
    // (which only reads the deepest pool per token) never uses.
    expect(DEFAULT_VENUES).toEqual(['MinswapV2', 'SundaeSwapV1', 'SundaeSwapV3', 'MuesliSwap', 'WingRiders', 'WingRidersV2']);
    expect(loadConfig(base, { blockfrost: false }).venues).toEqual(DEFAULT_VENUES);
  });

  it('parses an explicit COLLECT_VENUES list', () => {
    const c = loadConfig({ ...base, COLLECT_VENUES: 'Minswap,SundaeSwapV3' }, { blockfrost: false });
    expect(c.venues).toEqual(['Minswap', 'SundaeSwapV3']);
  });

  it('rejects an unknown venue in COLLECT_VENUES, naming it', () => {
    expect(() => loadConfig({ ...base, COLLECT_VENUES: 'Minswap,NotARealVenue' }, { blockfrost: false })).toThrow(
      /COLLECT_VENUES.*NotARealVenue/,
    );
  });

  it('treats an empty COLLECT_VENUES as unset (default), same as a bare `.env.example` line', () => {
    expect(loadConfig({ ...base, COLLECT_VENUES: '' }, { blockfrost: false }).venues).toEqual(DEFAULT_VENUES);
  });

  it('can include VyFinance explicitly even though it is excluded by default', () => {
    expect(VENUE_NAMES).toContain('VyFinance');
    const c = loadConfig({ ...base, COLLECT_VENUES: 'VyFinance' }, { blockfrost: false });
    expect(c.venues).toEqual(['VyFinance']);
  });

  it('can include Splash explicitly even though it is excluded by default', () => {
    expect(VENUE_NAMES).toContain('Splash');
    const c = loadConfig({ ...base, COLLECT_VENUES: 'Splash' }, { blockfrost: false });
    expect(c.venues).toEqual(['Splash']);
  });

  it('can re-enable Minswap v1 explicitly even though it is excluded by default', () => {
    const c = loadConfig({ ...base, COLLECT_VENUES: 'Minswap,MinswapV2' }, { blockfrost: false });
    expect(c.venues).toEqual(['Minswap', 'MinswapV2']);
  });

  it('defaults COLLECT_REFRESH to "deepest"', () => {
    expect(loadConfig(base, { blockfrost: false }).refreshPolicy).toBe('deepest');
  });

  it('treats an empty COLLECT_REFRESH as unset (default "deepest")', () => {
    expect(loadConfig({ ...base, COLLECT_REFRESH: '' }, { blockfrost: false }).refreshPolicy).toBe('deepest');
  });

  it('accepts an explicit COLLECT_REFRESH of "all"', () => {
    expect(loadConfig({ ...base, COLLECT_REFRESH: 'all' }, { blockfrost: false }).refreshPolicy).toBe('all');
  });

  it('fails closed on an unrecognized COLLECT_REFRESH value', () => {
    expect(() => loadConfig({ ...base, COLLECT_REFRESH: 'shallow' }, { blockfrost: false })).toThrow(/COLLECT_REFRESH/);
  });

  it('derives dashboardDatabaseUrl from DATABASE_URL when DASHBOARD_DATABASE_URL is unset', () => {
    expect(loadConfig(base, { blockfrost: false }).dashboardDatabaseUrl).toBe(
      'postgres://ctb_dashboard:ctb_dashboard_local_only@localhost:5433/ctb',
    );
  });

  it('treats an empty DASHBOARD_DATABASE_URL as unset (derives it)', () => {
    expect(loadConfig({ ...base, DASHBOARD_DATABASE_URL: '' }, { blockfrost: false }).dashboardDatabaseUrl).toBe(
      dashboardDatabaseUrl,
    );
  });

  it('an explicit DASHBOARD_DATABASE_URL wins over the derived one', () => {
    const explicit = 'postgres://someone:else@otherhost:9999/otherdb';
    expect(loadConfig({ ...base, DASHBOARD_DATABASE_URL: explicit }, { blockfrost: false }).dashboardDatabaseUrl).toBe(
      explicit,
    );
  });
});

describe('deriveDashboardUrl', () => {
  it('swaps in the ctb_dashboard credentials, leaving host/port/database untouched', () => {
    expect(deriveDashboardUrl('postgres://ctb:ctb_local_only@localhost:5433/ctb')).toBe(
      'postgres://ctb_dashboard:ctb_dashboard_local_only@localhost:5433/ctb',
    );
  });
});
