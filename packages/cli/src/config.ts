import { z } from 'zod';
import { DEFAULT_VENUES, isDexName, type DexName } from '@ctb/collector/pure';
import { DEFAULT_COLLECT_INTERVAL_SEC } from '@ctb/reports';

export { DEFAULT_COLLECT_INTERVAL_SEC } from '@ctb/reports';

export interface Config {
  databaseUrl: string;
  /** Ticker sampled every focus interval; null disables tiered sampling entirely. */
  focusTicker: string | null;
  /** 0 when tiered sampling is off. */
  focusIntervalSec: number;
  dashboardDatabaseUrl: string;
  blockfrostProjectId: string | null;
  intervalSec: number;
  /** Ceiling a discovery sweep is priced against; 0 disables the check. See COLLECT_DAILY_CALL_CEILING. */
  dailyCallCeiling: number;
  logLevel: string;
  venues: DexName[];
  refreshPolicy: 'deepest' | 'all';
  /** Lovelace floor for a pool to stay in the refresh set; 0n disables it. */
  minDepthLovelace: bigint;
}

/** DATABASE_URL with the read-only role's credentials; everything else (host, port, database) identical. */
export function deriveDashboardUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  u.username = 'ctb_dashboard';
  u.password = 'ctb_dashboard_local_only';
  return u.toString();
}

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Leave unset (or blank, same '' -> undefined preprocessing as the other optional knobs below) to
  // derive it from DATABASE_URL with the ctb_dashboard user (migration 0006).
  DASHBOARD_DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  // dotenv sets an unset-but-present `KEY=` line to '', not undefined; without this preprocess
  // `.optional()` never fires and commands that don't need Blockfrost (migrate/status) fail closed
  // on a blank BLOCKFROST_PROJECT_ID= line in .env, which .env.example ships by design.
  BLOCKFROST_PROJECT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  // 600 s (10 minutes): run 50 measured ~10 Blockfrost calls per refreshed pool; at the deepest-only
  // refresh set (~20 pools, one per token) that's ~29k calls/day at 300 s vs ~14k at 600 s — 600 s
  // leaves headroom under the 50k/day free quota alongside discovery's own daily cost. See
  // .env.example for the full arithmetic.
  COLLECT_INTERVAL_SECONDS: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? DEFAULT_COLLECT_INTERVAL_SEC : Number(v)))
    .refine((n) => Number.isInteger(n) && n >= 60, 'COLLECT_INTERVAL_SECONDS must be an integer >= 60'),
  /**
   * The ceiling a discovery sweep is priced against. Default 45,000 of Blockfrost's 50,000/day free
   * tier, so a refused sweep still leaves ~5,000 calls for the day's refresh ticks rather than
   * stopping collection outright. 0 disables the check.
   *
   * Chosen from the measured numbers, not a round guess: a sweep is ~5,700 and a full day of refresh
   * at 900 s is ~28,500, so 45,000 refuses a sweep only once the day is genuinely close to the wall.
   */
  COLLECT_DAILY_CALL_CEILING: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 45_000 : Number(v)))
    .refine((n) => Number.isInteger(n) && n >= 0, 'COLLECT_DAILY_CALL_CEILING must be a non-negative integer'),
  LOG_LEVEL: z.string().optional(),
  // Same '' -> undefined preprocessing as BLOCKFROST_PROJECT_ID: .env.example ships a bare
  // `COLLECT_VENUES=` line so dotenv loads '', which must mean "use the default", not "discover
  // nothing".
  COLLECT_VENUES: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // Fails closed on anything but 'deepest'/'all' (including a typo or an unrecognized future value)
  // rather than silently falling back to a default that changes the collector's Blockfrost budget
  // without anyone noticing. '' (a bare `COLLECT_REFRESH=` line, same shape as .env.example's other
  // optional knobs) means "use the default", same as unset.
  COLLECT_REFRESH: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'deepest' : v))
    .refine(
      (v): v is 'deepest' | 'all' => v === 'deepest' || v === 'all',
      'COLLECT_REFRESH must be "deepest" or "all"',
    ),
  // Whole ADA. 0 or unset keeps every token, which is the behaviour before this option existed.
  // See DexterPoolSourceOptions.minDepthLovelace for the measurement that motivates it.
  // The one token sampled every tick. Several samples inside one candle are the only way a real
  // high and low exist — before this, 2,306 of 2,306 candles had open = high = low = close. Unset
  // means every token is sampled at COLLECT_INTERVAL_SECONDS, exactly as before.
  COLLECT_FOCUS_TICKER: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // How often the focus token is sampled. Must divide COLLECT_INTERVAL_SECONDS, so a whole number
  // of samples lands in each candle and no sample straddles a boundary.
  COLLECT_FOCUS_INTERVAL_SECONDS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 0 : Number(v)))
    .refine((n) => n === 0 || (Number.isInteger(n) && n >= 20), 'COLLECT_FOCUS_INTERVAL_SECONDS must be 0 or an integer >= 20'),
  COLLECT_MIN_DEPTH_ADA: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 0 : Number(v)))
    .refine((n) => Number.isFinite(n) && n >= 0, 'COLLECT_MIN_DEPTH_ADA must be a non-negative number of ADA'),
});

export function loadConfig(env: NodeJS.ProcessEnv, needs: { blockfrost: boolean }): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`config: ${first?.path.join('.') || 'env'}: ${first?.message ?? 'invalid'}`);
  }
  const v = parsed.data;
  if (needs.blockfrost && !v.BLOCKFROST_PROJECT_ID) throw new Error('config: BLOCKFROST_PROJECT_ID is required for this command');
  let venues: DexName[];
  if (v.COLLECT_VENUES === undefined) {
    venues = DEFAULT_VENUES;
  } else {
    const names = v.COLLECT_VENUES.split(',').map((s) => s.trim());
    const unknown = names.filter((n) => !isDexName(n));
    if (unknown.length > 0) throw new Error(`config: COLLECT_VENUES: unknown venue(s): ${unknown.join(', ')}`);
    venues = names as DexName[];
  }
  // Fail closed on a focus interval that does not divide the candle interval: samples would
  // straddle boundaries and a candle's "first" and "last" would drift, which is a silently wrong
  // open and close rather than an error.
  if (v.COLLECT_FOCUS_INTERVAL_SECONDS > 0) {
    if (!v.COLLECT_FOCUS_TICKER) {
      throw new Error('COLLECT_FOCUS_INTERVAL_SECONDS is set but COLLECT_FOCUS_TICKER is not; set both or neither');
    }
    if (v.COLLECT_INTERVAL_SECONDS % v.COLLECT_FOCUS_INTERVAL_SECONDS !== 0) {
      throw new Error(`COLLECT_FOCUS_INTERVAL_SECONDS (${v.COLLECT_FOCUS_INTERVAL_SECONDS}) must divide COLLECT_INTERVAL_SECONDS (${v.COLLECT_INTERVAL_SECONDS})`);
    }
  }
  if (v.COLLECT_FOCUS_TICKER && v.COLLECT_FOCUS_INTERVAL_SECONDS === 0) {
    throw new Error('COLLECT_FOCUS_TICKER is set but COLLECT_FOCUS_INTERVAL_SECONDS is not; set both or neither');
  }
  return {
    databaseUrl: v.DATABASE_URL,
    dashboardDatabaseUrl: v.DASHBOARD_DATABASE_URL ?? deriveDashboardUrl(v.DATABASE_URL),
    blockfrostProjectId: v.BLOCKFROST_PROJECT_ID ?? null,
    intervalSec: v.COLLECT_INTERVAL_SECONDS,
    dailyCallCeiling: v.COLLECT_DAILY_CALL_CEILING,
    logLevel: v.LOG_LEVEL ?? 'info',
    venues,
    refreshPolicy: v.COLLECT_REFRESH,
    minDepthLovelace: BigInt(Math.round(v.COLLECT_MIN_DEPTH_ADA * 1_000_000)),
    focusTicker: v.COLLECT_FOCUS_TICKER ?? null,
    focusIntervalSec: v.COLLECT_FOCUS_INTERVAL_SECONDS,
  };
}
