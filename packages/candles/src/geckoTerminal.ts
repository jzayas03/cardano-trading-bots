import type { Logger } from '@ctb/collector';
import type { Decimal } from './types.js';

export interface GeckoPool { id: string; hex: string; name: string; dex: string; reserveUsd: number | null }
export interface GeckoCandle { tickTs: Date; open: Decimal; high: Decimal; low: Decimal; close: Decimal; volumeQuote: Decimal }

export interface GeckoTerminalClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Free tier: five rapid calls returned 429 on 2026-09-06. */
  minSpacingMs?: number;
  baseUrl?: string;
  log: Logger;
  random?: () => number;
}

const RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export class GeckoTerminalClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spacing: number;
  private readonly base: string;
  private readonly log: Logger;
  private readonly random: () => number;
  private lastCallAt = 0;
  private count = 0;

  constructor(o: GeckoTerminalClientOptions) {
    this.fetchImpl = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.spacing = o.minSpacingMs ?? 3_000;
    this.base = o.baseUrl ?? 'https://api.geckoterminal.com/api/v2';
    this.log = o.log;
    this.random = o.random ?? Math.random;
  }

  calls(): number { return this.count; }

  async listAdaPools(unit: string): Promise<GeckoPool[]> {
    const body = (await this.get(`/networks/cardano/tokens/${unit}/pools?page=1`)) as {
      data?: Array<{ id: string; attributes: { name: string; address: string; reserve_in_usd: string | null }; relationships: { dex: { data: { id: string } } } }>;
    };
    return (body.data ?? [])
      .filter((p) => p.attributes.name.split(' / ').includes('ADA'))
      .map((p) => ({
        id: p.id, hex: p.attributes.address, name: p.attributes.name, dex: p.relationships.dex.data.id,
        reserveUsd: p.attributes.reserve_in_usd === null ? null : Number(p.attributes.reserve_in_usd),
      }));
  }

  async ohlcv5m(poolHex: string, beforeTs?: Date): Promise<GeckoCandle[]> {
    const before = beforeTs ? `&before_timestamp=${Math.floor(beforeTs.getTime() / 1000)}` : '';
    const body = (await this.get(`/networks/cardano/pools/${poolHex}/ohlcv/minute?aggregate=5&limit=1000${before}`)) as {
      data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
    };
    const list = body.data?.attributes?.ohlcv_list ?? [];
    return list
      .map(([ts, o, h, l, c, v]) => ({ tickTs: new Date(ts * 1000), open: String(o), high: String(h), low: String(l), close: String(c), volumeQuote: String(v) }))
      .sort((a, b) => a.tickTs.getTime() - b.tickTs.getTime());
  }

  private async get(path: string): Promise<unknown> {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      const wait = this.lastCallAt + this.spacing - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCallAt = Date.now();
      this.count++;
      const res = await this.fetchImpl(`${this.base}${path}`, { headers: { Accept: 'application/json;version=20230302' } });
      if (res.ok) return res.json();
      lastStatus = res.status;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient) throw new Error(`geckoterminal ${path} returned ${res.status}`);
      if (attempt === RETRY_ATTEMPTS) break;
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + Math.floor(this.random() * 1_000);
      this.log.warn({ path, status: res.status, attempt, backoffMs: backoff }, 'geckoterminal transient error, backing off');
      await this.sleep(backoff);
    }
    throw new Error(`geckoterminal ${path} returned ${lastStatus} after ${RETRY_ATTEMPTS} attempts`);
  }
}

/** Identifier match wins (our MinswapV2 pool_id suffix equals Gecko's hex); otherwise the deepest ADA pool. */
export function chooseExternalPool(
  pools: GeckoPool[],
  knownIdentifiers: string[],
): { pool: GeckoPool; method: 'identifier' | 'pair_largest_reserve' } | null {
  const byId = pools.find((p) => knownIdentifiers.includes(p.hex));
  if (byId) return { pool: byId, method: 'identifier' };
  const deepest = [...pools].sort((a, b) => (b.reserveUsd ?? -1) - (a.reserveUsd ?? -1))[0];
  return deepest ? { pool: deepest, method: 'pair_largest_reserve' } : null;
}
