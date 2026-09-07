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
/** Widest the adaptive spacing will go: past this a sweep is unusably slow and the limit is something else. */
export const MAX_SPACING_MS = 30_000;
/** How much of the widened spacing survives each success: back to the base in about a dozen clean calls. */
const SPACING_DECAY = 0.85;

export class GeckoTerminalClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Current spacing: the base, widened after every 429 and decayed back toward the base after each success. */
  private spacing: number;
  private readonly baseSpacing: number;
  private readonly base: string;
  private readonly log: Logger;
  private readonly random: () => number;
  private lastCallAt = 0;
  private count = 0;

  constructor(o: GeckoTerminalClientOptions) {
    this.fetchImpl = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseSpacing = o.minSpacingMs ?? 3_000;
    this.spacing = this.baseSpacing;
    this.base = o.baseUrl ?? 'https://api.geckoterminal.com/api/v2';
    this.log = o.log;
    this.random = o.random ?? Math.random;
  }

  calls(): number { return this.count; }
  /** The spacing currently in force, for the sweep's summary line and for tests. */
  currentSpacingMs(): number { return this.spacing; }

  /**
   * 2026-09-07's universe backfill: 118 rate limits in 40 minutes at the 3 s base, most cleared on
   * the first retry, a median 9 s apart — so the base was simply too fast for this endpoint and
   * every 429 was a wasted call plus a 5-10 s penalty. Now a 429 doubles the spacing (capped), a
   * `Retry-After` header is honored as the floor of the wait, and each success decays the spacing
   * back toward the base. The exponential retry backoff stays as the fallback for the same call.
   */
  private widen(retryAfterMs: number | null): void {
    const next = Math.min(MAX_SPACING_MS, Math.max(this.spacing * 2, retryAfterMs ?? 0));
    if (next !== this.spacing) {
      this.log.info({ fromMs: this.spacing, toMs: next, retryAfterMs }, 'geckoterminal 429: widening call spacing');
      this.spacing = next;
    }
  }

  private relax(): void {
    if (this.spacing > this.baseSpacing) this.spacing = Math.max(this.baseSpacing, Math.round(this.spacing * SPACING_DECAY));
  }

  async listAdaPools(unit: string): Promise<GeckoPool[]> {
    const body = (await this.get(`/networks/cardano/tokens/${unit}/pools?page=1`)) as {
      data?: Array<{ id: string; attributes: { name: string; address: string; reserve_in_usd: string | null }; relationships: { dex: { data: { id: string } } } }>;
    };
    const out: GeckoPool[] = [];
    for (const p of body.data ?? []) {
      // `X / ADA` quotes in ADA per X, which is what our candles mean. `ADA / X` quotes the other way
      // round, so importing it as history inverts every price in the series — and because that name
      // also contains the string 'ADA', a membership test happily accepted it (finding I2). The skip
      // is logged rather than silent: an inverted pool that is also the deepest is worth knowing about.
      const [base, quote] = p.attributes.name.split(' / ');
      if (quote !== 'ADA') {
        if (base === 'ADA') this.log.warn({ pool: p.attributes.address, name: p.attributes.name }, 'skipping ADA-first pool: its prices are quoted in the wrong direction');
        continue;
      }
      out.push({
        id: p.id, hex: p.attributes.address, name: p.attributes.name, dex: p.relationships.dex.data.id,
        reserveUsd: p.attributes.reserve_in_usd === null ? null : Number(p.attributes.reserve_in_usd),
      });
    }
    return out;
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
    let lastMessage = '';
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      const wait = this.lastCallAt + this.spacing - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCallAt = Date.now();
      this.count++;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, { headers: { Accept: 'application/json;version=20230302' } });
      } catch (err) {
        // A rejected fetch (DNS failure, connection reset, timeout) never produces a Response, so
        // it can't be read as a status code — but it is exactly as transient as a 429/5xx and
        // must not be allowed to abort the whole backfill on one flaky network blip.
        lastMessage = `geckoterminal ${path} network error: ${(err as Error).message}`;
        if (attempt === RETRY_ATTEMPTS) break;
        const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + Math.floor(this.random() * 1_000);
        this.log.warn({ path, err: (err as Error).message, attempt, backoffMs: backoff }, 'geckoterminal network error, backing off');
        await this.sleep(backoff);
        continue;
      }
      if (res.ok) { this.relax(); return res.json(); }
      lastMessage = `geckoterminal ${path} returned ${res.status}`;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient) throw new Error(lastMessage);
      const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : null;
      if (res.status === 429) this.widen(retryAfterMs);
      if (attempt === RETRY_ATTEMPTS) break;
      const backoff = Math.max(retryAfterMs ?? 0, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + Math.floor(this.random() * 1_000));
      this.log.warn({ path, status: res.status, attempt, backoffMs: backoff, spacingMs: this.spacing }, 'geckoterminal transient error, backing off');
      await this.sleep(backoff);
    }
    throw new Error(`${lastMessage} after ${RETRY_ATTEMPTS} attempts`);
  }
}

/** `Retry-After` in seconds (the only form GeckoTerminal would send); null when absent or unparseable. An HTTP-date form is ignored rather than guessed at. */
export function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const n = Number(header.trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
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
