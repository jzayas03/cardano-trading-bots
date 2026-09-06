import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { universeFileSchema } from './schema.js';

export interface TokenSpec {
  ticker: string;
  policyId: string;
  assetNameHex: string;
  decimals: number;
  category: string;
  /** policyId || assetNameHex: the Cardano asset identifier used by Blockfrost and Dexter. */
  unit: string;
}

export interface Pair {
  base: TokenSpec;
  quote: 'lovelace';
}

export interface Universe {
  seededAt: string;
  seedSource: string;
  tokens: TokenSpec[];
  pairs: Pair[];
}

export const UNIVERSE_FILE = fileURLToPath(new URL('../universe.json', import.meta.url));

/** Pure validation. Every failure names the entry so a bad row is fixed, never skipped. */
export function parseUniverse(raw: unknown): Universe {
  const parsed = universeFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const idx = issue?.path[1];
    const ticker =
      typeof idx === 'number' && typeof raw === 'object' && raw !== null
        ? (raw as { tokens?: Array<{ ticker?: unknown }> }).tokens?.[idx]?.ticker
        : undefined;
    const where = issue ? issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('').replace(/^\./, '') : '?';
    throw new Error(`universe invalid at ${where}${ticker ? ` (${String(ticker)})` : ''}: ${issue?.message ?? 'unknown'}`);
  }
  const tokens: TokenSpec[] = parsed.data.tokens.map((t) => ({ ...t, unit: t.policyId + t.assetNameHex }));
  const units = new Set<string>();
  const tickers = new Set<string>();
  for (const t of tokens) {
    if (units.has(t.unit)) throw new Error(`universe invalid: duplicate unit ${t.unit} (${t.ticker})`);
    if (tickers.has(t.ticker)) throw new Error(`universe invalid: duplicate ticker ${t.ticker}`);
    units.add(t.unit);
    tickers.add(t.ticker);
  }
  return {
    seededAt: parsed.data.seededAt,
    seedSource: parsed.data.seedSource,
    tokens,
    pairs: tokens.map((base) => ({ base, quote: 'lovelace' as const })),
  };
}

export async function loadUniverse(file: string = UNIVERSE_FILE): Promise<Universe> {
  const text = await readFile(file, 'utf8');
  return parseUniverse(JSON.parse(text));
}
