/** Every venue Dexter 5.4.10 knows. Pool type is asserted here because Dexter exposes none;
 *  Minswap v2 / Splash stable pools are discovered by different validity assets and never reach us.
 *
 *  `discovery` records how each venue's pools are actually found on-chain, in one place so
 *  `dexterSource.ts`'s bounded-path strategy map and the CLI's default venue list both derive from
 *  it instead of duplicating the same two facts:
 *   - 'dexter': Dexter's own `FetchRequest.getLiquidityPools()` is fine (bounded to that venue's
 *     token-pair filter already).
 *   - 'per-token-address': Dexter's own discovery scans every UTxO at the venue's pool addresses
 *     unfiltered (thousands of pools for Splash); `dexterSource.ts` instead queries Blockfrost's
 *     asset-filtered UTxO endpoint per address/token.
 *   - 'unsupported': Dexter has no on-chain discovery for the venue at all (VyFinance's
 *     `liquidityPools()` rejects with "Not implemented ..."), so it is excluded from the default
 *     `COLLECT_VENUES` list rather than failing every tick. */
export const VENUES = {
  Minswap: { poolType: 'cpmm', discovery: 'dexter' },
  MinswapV2: { poolType: 'cpmm', discovery: 'dexter' },
  SundaeSwapV1: { poolType: 'cpmm', discovery: 'dexter' },
  SundaeSwapV3: { poolType: 'cpmm', discovery: 'dexter' },
  MuesliSwap: { poolType: 'cpmm', discovery: 'dexter' },
  WingRiders: { poolType: 'cpmm', discovery: 'dexter' },
  WingRidersV2: { poolType: 'cpmm', discovery: 'dexter' },
  VyFinance: { poolType: 'cpmm', discovery: 'unsupported' },
  Splash: { poolType: 'cpmm', discovery: 'per-token-address' },
} as const satisfies Record<string, { poolType: 'cpmm'; discovery: 'dexter' | 'per-token-address' | 'unsupported' }>;

export type DexName = keyof typeof VENUES;
export const VENUE_NAMES = Object.keys(VENUES) as DexName[];

export function isDexName(name: string): name is DexName {
  return Object.prototype.hasOwnProperty.call(VENUES, name);
}

/** Every venue whose on-chain discovery actually works (excludes `discovery: 'unsupported'`, i.e.
 *  VyFinance). This is `Config.venues`' default so a fresh checkout doesn't fail every tick on a
 *  venue Dexter itself can't discover. */
export const DEFAULT_VENUES: DexName[] = VENUE_NAMES.filter((name) => VENUES[name].discovery !== 'unsupported');
