/** Every venue Dexter 5.4.10 knows. Pool type is asserted here because Dexter exposes none;
 *  Minswap v2 / Splash stable pools are discovered by different validity assets and never reach us. */
export const VENUES = {
  Minswap: { poolType: 'cpmm' },
  MinswapV2: { poolType: 'cpmm' },
  SundaeSwapV1: { poolType: 'cpmm' },
  SundaeSwapV3: { poolType: 'cpmm' },
  MuesliSwap: { poolType: 'cpmm' },
  WingRiders: { poolType: 'cpmm' },
  WingRidersV2: { poolType: 'cpmm' },
  VyFinance: { poolType: 'cpmm' },
  Splash: { poolType: 'cpmm' },
} as const satisfies Record<string, { poolType: 'cpmm' }>;

export type DexName = keyof typeof VENUES;
export const VENUE_NAMES = Object.keys(VENUES) as DexName[];

export function isDexName(name: string): name is DexName {
  return Object.prototype.hasOwnProperty.call(VENUES, name);
}
