/** Every venue Dexter 5.4.10 knows. Pool type is asserted here because Dexter exposes none;
 *  Minswap v2 / Splash stable pools are discovered by different validity assets and never reach us.
 *
 *  `discovery` records how each venue's pools are actually found on-chain, in one place so
 *  `dexterSource.ts`'s bounded-path strategy map and the CLI's default venue list both derive from
 *  it instead of duplicating the same two facts:
 *   - 'dexter': Dexter's own `FetchRequest.getLiquidityPools()` is fine (bounded to that venue's
 *     token-pair filter already).
 *   - 'per-token-address': Dexter's own discovery scans every UTxO at the venue's pool addresses
 *     unfiltered (thousands of pools for Splash); `dexterSource.ts` has a bounded alternative that
 *     instead queries Blockfrost's asset-filtered UTxO endpoint per address/token
 *     (`DefaultPoolFetcher.discoverBounded`). No venue currently uses this value — see Splash below —
 *     but the strategy and its code path are kept so re-enabling a venue is a one-line change here.
 *   - 'unsupported': Dexter has no usable on-chain discovery for the venue at all, so it is excluded
 *     from the default `COLLECT_VENUES` list rather than failing every tick:
 *     - VyFinance: `liquidityPools()` is a hardcoded `Promise.reject('Not implemented ...')`.
 *     - Splash: the bounded path above would call Dexter's own `Splash.liquidityPoolFromUtxo` (no
 *       reason to hand-roll Splash's datum parsing when Dexter already has it) — but the installed
 *       `@indigo-labs/dexter@5.4.10` build of that method never returns the pool it parses. Verified
 *       by reading `node_modules/@indigo-labs/dexter/build/dex/splash.js`: the function builds and
 *       fully populates the `LiquidityPool` object on a successful parse, then falls through, on
 *       every path, to an unconditional `return undefined;` (the final statement of the function,
 *       after the try/catch; the catch block itself also `return undefined;`s) — there is no
 *       `return liquidityPool` anywhere in the function, unlike e.g. `minswap-v2.js`'s equivalent
 *       method, which does return it. So no Splash pool can be discovered through Dexter regardless
 *       of which discovery path is used, until Dexter is patched/upgraded or this codebase grows its
 *       own Splash datum parsing instead of delegating to Dexter's broken method. Confirmed against
 *       the first real collector tick (run 50, 2026-09-06, mainnet): Splash alone burned roughly 24k
 *       of the tick's 39,781 Blockfrost calls and still contributed zero pools. */
export const VENUES = {
  // Minswap v1 is `enabledByDefault: false`: run 50 (2026-09-06, real key, mainnet) shows it costs
  // ~9,600 discovery calls/day for 14 shallow pools that are, for every token but AGIX, never the
  // deepest pool for their token — the deepest pool per token is on Minswap v2 for 19/20 tokens, and
  // candles already only read the deepest pool per token per tick (`buildCandles` in `@ctb/candles`),
  // so discovering and refreshing those 14 pools spends quota the candle pipeline never uses. Still
  // requestable explicitly via `COLLECT_VENUES=Minswap,...`.
  Minswap: { poolType: 'cpmm', discovery: 'dexter', enabledByDefault: false },
  MinswapV2: { poolType: 'cpmm', discovery: 'dexter', enabledByDefault: true },
  SundaeSwapV1: { poolType: 'cpmm', discovery: 'dexter', enabledByDefault: true },
  SundaeSwapV3: { poolType: 'cpmm', discovery: 'dexter', enabledByDefault: true },
  MuesliSwap: { poolType: 'cpmm', discovery: 'dexter', enabledByDefault: true },
  WingRiders: { poolType: 'cpmm', discovery: 'dexter', enabledByDefault: true },
  WingRidersV2: { poolType: 'cpmm', discovery: 'dexter', enabledByDefault: true },
  // Unsupported venues are excluded from DEFAULT_VENUES regardless of enabledByDefault (see the
  // filter below); the flag is still `false` here so the two facts — "can this be discovered at all"
  // and "should a working venue be on by default" — don't silently diverge for either of these two.
  VyFinance: { poolType: 'cpmm', discovery: 'unsupported', enabledByDefault: false },
  Splash: { poolType: 'cpmm', discovery: 'unsupported', enabledByDefault: false },
} as const satisfies Record<string, {
  poolType: 'cpmm';
  discovery: 'dexter' | 'per-token-address' | 'unsupported';
  enabledByDefault: boolean;
}>;

export type DexName = keyof typeof VENUES;
export const VENUE_NAMES = Object.keys(VENUES) as DexName[];

export type Discovery = 'dexter' | 'per-token-address' | 'unsupported';

/**
 * `VENUES[name].discovery`, widened to `Discovery`. `VENUES` is declared `as const`, so TS infers
 * each venue's `discovery` as its own specific literal — with no venue currently `'per-token-address'`
 * (see the header comment above), the union of literals actually present narrows to `'dexter' |
 * 'unsupported'`, and comparing that to `'per-token-address'` is a compile error (no overlap), not
 * just an always-false runtime check. This accessor's declared return type re-widens it so callers
 * (dexterSource.ts's `BOUNDED_DISCOVERY`) can still ask the general question.
 */
export function discoveryOf(name: DexName): Discovery { return VENUES[name].discovery; }

export function isDexName(name: string): name is DexName {
  return Object.prototype.hasOwnProperty.call(VENUES, name);
}

/** Every venue whose on-chain discovery actually works AND is `enabledByDefault` (excludes
 *  `discovery: 'unsupported'` — VyFinance and Splash, see the header comment above for why Splash is
 *  unsupported too despite having a bounded discovery strategy — and excludes Minswap v1, whose
 *  `enabledByDefault: false` is explained on that entry above). This is `Config.venues`' default so a
 *  fresh checkout doesn't fail every tick on a venue Dexter can't discover, and doesn't spend quota
 *  discovering/refreshing pools the candle pipeline never reads. */
export const DEFAULT_VENUES: DexName[] = VENUE_NAMES.filter(
  (name) => VENUES[name].discovery !== 'unsupported' && VENUES[name].enabledByDefault,
);
