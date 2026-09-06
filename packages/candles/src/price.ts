import type { Decimal } from './types.js';

export const PRICE_SCALE = 18;
const SCALE = 10n ** BigInt(PRICE_SCALE);
const LOVELACE_PER_ADA = 1_000_000n;

/** ADA per whole token = (reserveQuote / 1e6) / (reserveBase / 10^decimals), as an 18-place decimal string. */
export function priceAdaPerToken(reserveQuote: bigint, reserveBase: bigint, decimals: number): Decimal {
  if (reserveQuote <= 0n || reserveBase <= 0n) throw new Error(`price needs positive reserves, got quote=${reserveQuote} base=${reserveBase}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`decimals out of range: ${decimals}`);
  const scaled = (reserveQuote * 10n ** BigInt(decimals) * SCALE) / (reserveBase * LOVELACE_PER_ADA);
  return formatScaled(scaled);
}

export function formatScaled(scaled: bigint): Decimal {
  const s = scaled.toString().padStart(PRICE_SCALE + 1, '0');
  return `${s.slice(0, -PRICE_SCALE)}.${s.slice(-PRICE_SCALE)}`;
}

/** For indicators and reports only. Never use the result as an amount. */
export function decimalToNumber(d: Decimal): number {
  const n = Number(d);
  if (!Number.isFinite(n)) throw new Error(`not a finite decimal: ${d}`);
  return n;
}
