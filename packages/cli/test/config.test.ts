import { describe, expect, it } from 'vitest';
import { DEFAULT_VENUES, VENUE_NAMES } from '@ctb/collector/pure';
import { deriveDashboardUrl, loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://ctb:x@localhost:5433/ctb' };
const dashboardDatabaseUrl = deriveDashboardUrl(base.DATABASE_URL);

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base, { blockfrost: false });
    expect(c).toEqual({
      databaseUrl: base.DATABASE_URL, dashboardDatabaseUrl, blockfrostProjectId: null, intervalSec: 600,
      dailyCallCeiling: 45_000,
      multiVenueEveryNTicks: 0,
      multiVenueMinDepthLovelace: 50_000_000_000n, logLevel: 'info',
      venues: DEFAULT_VENUES, refreshPolicy: 'deepest', minDepthLovelace: 0n, focusTicker: null, focusIntervalSec: 0,
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
      dailyCallCeiling: 45_000,
      multiVenueEveryNTicks: 0,
      multiVenueMinDepthLovelace: 50_000_000_000n,
      logLevel: 'info',
      venues: DEFAULT_VENUES,
      refreshPolicy: 'deepest', minDepthLovelace: 0n, focusTicker: null, focusIntervalSec: 0,
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

/**
 * The refresh depth floor. Off by default so an existing deployment is unchanged; whole ADA in the
 * environment, lovelace in the config, because every amount in this codebase is lovelace bigint.
 */
describe('COLLECT_MIN_DEPTH_ADA', () => {
  const base = { DATABASE_URL: 'postgres://ctb:ctb_local_only@localhost:5433/ctb' };
  it('is 0 when unset or blank, which disables the filter', () => {
    expect(loadConfig(base, { blockfrost: false }).minDepthLovelace).toBe(0n);
    expect(loadConfig({ ...base, COLLECT_MIN_DEPTH_ADA: '' }, { blockfrost: false }).minDepthLovelace).toBe(0n);
  });
  it('converts whole ADA to lovelace', () => {
    expect(loadConfig({ ...base, COLLECT_MIN_DEPTH_ADA: '400000' }, { blockfrost: false }).minDepthLovelace).toBe(400_000_000_000n);
    expect(loadConfig({ ...base, COLLECT_MIN_DEPTH_ADA: '0.5' }, { blockfrost: false }).minDepthLovelace).toBe(500_000n);
  });
  it('refuses a negative or non-numeric value rather than silently disabling itself', () => {
    expect(() => loadConfig({ ...base, COLLECT_MIN_DEPTH_ADA: '-1' }, { blockfrost: false })).toThrow(/COLLECT_MIN_DEPTH_ADA/);
    expect(() => loadConfig({ ...base, COLLECT_MIN_DEPTH_ADA: 'deep' }, { blockfrost: false })).toThrow(/COLLECT_MIN_DEPTH_ADA/);
  });
});

describe('tiered sampling config', () => {
  const base = { DATABASE_URL: 'postgres://x/y' } as NodeJS.ProcessEnv;

  it('is off by default, so nothing changes for an existing deployment', () => {
    const c = loadConfig(base, { blockfrost: false });
    expect(c.focusTicker).toBeNull();
    expect(c.focusIntervalSec).toBe(0);
  });

  it('accepts a focus token whose interval divides the candle interval', () => {
    const c = loadConfig({ ...base, COLLECT_INTERVAL_SECONDS: '900', COLLECT_FOCUS_TICKER: 'SNEK', COLLECT_FOCUS_INTERVAL_SECONDS: '60' }, { blockfrost: false });
    expect(c.focusTicker).toBe('SNEK');
    expect(c.focusIntervalSec).toBe(60);
  });

  it('REFUSES an interval that does not divide the candle interval', () => {
    // Samples would straddle boundaries and a candle's first and last would drift — a silently
    // wrong open and close, which is worse than an error.
    expect(() => loadConfig({ ...base, COLLECT_INTERVAL_SECONDS: '900', COLLECT_FOCUS_TICKER: 'SNEK', COLLECT_FOCUS_INTERVAL_SECONDS: '70' }, { blockfrost: false }))
      .toThrow(/must divide/);
  });

  it('REFUSES half a configuration in either direction', () => {
    expect(() => loadConfig({ ...base, COLLECT_FOCUS_TICKER: 'SNEK' }, { blockfrost: false })).toThrow(/set both or neither/);
    expect(() => loadConfig({ ...base, COLLECT_FOCUS_INTERVAL_SECONDS: '60' }, { blockfrost: false })).toThrow(/set both or neither/);
  });

  it('refuses an interval too small to be a real cadence', () => {
    expect(() => loadConfig({ ...base, COLLECT_FOCUS_TICKER: 'SNEK', COLLECT_FOCUS_INTERVAL_SECONDS: '5' }, { blockfrost: false })).toThrow(/>= 20/);
  });

  it('COLLECT_DAILY_CALL_CEILING defaults to 45,000 and accepts 0 to disable the check', () => {
    // Default, not zero: an unset ceiling must still bound the day. Zero has to be asked for.
    expect(loadConfig(base, { blockfrost: false }).dailyCallCeiling).toBe(45_000);
    // dotenv turns a bare `COLLECT_DAILY_CALL_CEILING=` line into '', which means "use the default",
    // not "no ceiling" -- the same '' handling BLOCKFROST_PROJECT_ID and COLLECT_VENUES need.
    expect(loadConfig({ ...base, COLLECT_DAILY_CALL_CEILING: '' }, { blockfrost: false }).dailyCallCeiling).toBe(45_000);
    expect(loadConfig({ ...base, COLLECT_DAILY_CALL_CEILING: '0' }, { blockfrost: false }).dailyCallCeiling).toBe(0);
    expect(loadConfig({ ...base, COLLECT_DAILY_CALL_CEILING: '30000' }, { blockfrost: false }).dailyCallCeiling).toBe(30_000);
  });

  it('refuses a nonsense ceiling instead of coercing it to a number that bounds nothing', () => {
    // `Number('abc')` is NaN and every comparison against NaN is false, so an unvalidated typo here
    // would disable the ceiling silently -- which is the failure mode it exists to prevent.
    expect(() => loadConfig({ ...base, COLLECT_DAILY_CALL_CEILING: 'abc' }, { blockfrost: false })).toThrow(/COLLECT_DAILY_CALL_CEILING/);
    expect(() => loadConfig({ ...base, COLLECT_DAILY_CALL_CEILING: '-1' }, { blockfrost: false })).toThrow(/COLLECT_DAILY_CALL_CEILING/);
    expect(() => loadConfig({ ...base, COLLECT_DAILY_CALL_CEILING: '1.5' }, { blockfrost: false })).toThrow(/COLLECT_DAILY_CALL_CEILING/);
  });

  it('COLLECT_MULTI_VENUE_EVERY_N_TICKS is off by default and refuses nonsense', () => {
    // Off by default: multi-venue pricing costs quota and answers a research question, so it is
    // opted into deliberately rather than inherited.
    expect(loadConfig(base, { blockfrost: false }).multiVenueEveryNTicks).toBe(0);
    expect(loadConfig({ ...base, COLLECT_MULTI_VENUE_EVERY_N_TICKS: '4' }, { blockfrost: false }).multiVenueEveryNTicks).toBe(4);
    expect(() => loadConfig({ ...base, COLLECT_MULTI_VENUE_EVERY_N_TICKS: '-1' }, { blockfrost: false })).toThrow(/COLLECT_MULTI_VENUE_EVERY_N_TICKS/);
    expect(() => loadConfig({ ...base, COLLECT_MULTI_VENUE_EVERY_N_TICKS: 'x' }, { blockfrost: false })).toThrow(/COLLECT_MULTI_VENUE_EVERY_N_TICKS/);
  });

  it('the depth floor converts ADA to lovelace and defaults to 50,000 ADA', () => {
    // A spread against a pool nobody can trade is not an opportunity — NIGHT's 404 bps gap was to a
    // pool holding a tenth of the depth.
    expect(loadConfig(base, { blockfrost: false }).multiVenueMinDepthLovelace).toBe(50_000_000_000n);
    expect(loadConfig({ ...base, COLLECT_MULTI_VENUE_MIN_DEPTH_ADA: '250000' }, { blockfrost: false }).multiVenueMinDepthLovelace).toBe(250_000_000_000n);
  });
});
