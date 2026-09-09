import { describe, expect, it } from 'vitest';
import { backfillToken, type ExternalRepo, type GeckoCandle, type GeckoPool } from '../src/index.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const day = 86_400_000;
const t0 = Date.UTC(2026, 8, 1);
const candle = (ms: number): GeckoCandle => ({ tickTs: new Date(ms), open: '1', high: '1', low: '1', close: '1', volumeQuote: '0' });

class FakeClient {
  pages: GeckoCandle[][];
  requestedBefore: Array<Date | undefined> = [];
  constructor(pages: GeckoCandle[][]) { this.pages = pages; }
  async listAdaPools(): Promise<GeckoPool[]> { return [{ id: 'cardano_aaa', hex: 'aaa', name: 'X / ADA', dex: 'minswap-cardano', reserveUsd: 1 }]; }
  async ohlcv5m(_hex: string, before?: Date): Promise<GeckoCandle[]> { this.requestedBefore.push(before); return this.pages.shift() ?? []; }
  calls() { return this.requestedBefore.length; }
}

class FakeRepo implements ExternalRepo {
  map: Parameters<ExternalRepo['putMap']>[0] | null = null;
  rows = new Map<number, GeckoCandle>();
  async getMap() { return this.map ? { externalPoolId: this.map.externalPoolId, externalDex: this.map.externalDex, matchMethod: this.map.matchMethod } : null; }
  async putMap(m: Parameters<ExternalRepo['putMap']>[0]) { this.map = m; }
  async knownMinswapV2Identifiers() { return []; }
  async upsertExternal(_u: string, _p: string, candles: GeckoCandle[]) { let n = 0; for (const c of candles) { if (!this.rows.has(c.tickTs.getTime())) { this.rows.set(c.tickTs.getTime(), c); n++; } } return n; }
  async readExternal() { return [...this.rows.values()]; }
  async coverage() { return { first: null, last: null, rows: this.rows.size }; }
}

describe('backfillToken', () => {
  it('pages backwards until the window start, upserts, records the pool map', async () => {
    const page1 = [candle(t0 + 2 * day), candle(t0 + 3 * day)]; // newest page (ascending within page)
    const page2 = [candle(t0 - 1 * day), candle(t0 + 1 * day)]; // reaches below `from`
    const client = new FakeClient([page1, page2]);
    const repo = new FakeRepo();
    const r = await backfillToken({ client: client as never, repo, token: { unit: 'u', ticker: 'X' }, denomination: 'ada', from: new Date(t0), to: new Date(t0 + 4 * day), log });
    expect(r).toEqual({ pages: 2, rows: 3, pool: 'aaa', method: 'pair_largest_reserve' });
    expect(client.requestedBefore[0]).toEqual(new Date(t0 + 4 * day));
    expect(client.requestedBefore[1]).toEqual(new Date(t0 + 2 * day)); // oldest row of page1
    expect([...repo.rows.keys()].sort()).toEqual([t0 + 1 * day, t0 + 2 * day, t0 + 3 * day]); // the row before `from` is dropped
    expect(repo.map?.matchMethod).toBe('pair_largest_reserve');
  });

  it('stops on an empty page and is idempotent', async () => {
    const repo = new FakeRepo();
    const c1 = new FakeClient([[candle(t0 + day)], []]);
    const r1 = await backfillToken({ client: c1 as never, repo, token: { unit: 'u', ticker: 'X' }, denomination: 'ada', from: new Date(t0 - 10 * day), to: new Date(t0 + 4 * day), log });
    expect(r1.pages).toBe(2);
    const c2 = new FakeClient([[candle(t0 + day)], []]);
    const r2 = await backfillToken({ client: c2 as never, repo, token: { unit: 'u', ticker: 'X' }, denomination: 'ada', from: new Date(t0 - 10 * day), to: new Date(t0 + 4 * day), log });
    expect(r2.rows).toBe(0);
  });

  it('fails closed when no ADA pool exists', async () => {
    const client = new FakeClient([]);
    client.listAdaPools = async () => [];
    await expect(backfillToken({ client: client as never, repo: new FakeRepo(), token: { unit: 'u', ticker: 'X' }, denomination: 'ada', from: new Date(t0), to: new Date(t0 + day), log }))
      .rejects.toThrow(/no ADA pool on geckoterminal for X/);
  });

  /**
   * Finding M6: `before` was set to the oldest row of each page unconditionally. A pool whose oldest
   * bucket is at the start of its history returns the SAME page forever, so the loop spent 400
   * requests (and, at 3 s spacing, twenty minutes) re-importing zero new rows before MAX_PAGES saved
   * it. If the window did not advance, there is nothing older to fetch.
   */
  it('stops when a page does not reach further back than the last one', async () => {
    const warned: Array<Record<string, unknown>> = [];
    const noisy = { info: () => {}, warn: (o: Record<string, unknown>) => { warned.push(o); }, error: () => {} };
    const stuck = [candle(t0 + 2 * day), candle(t0 + 3 * day)];
    const client = new FakeClient([stuck, [...stuck], [...stuck], [...stuck]]);
    const r = await backfillToken({ client: client as never, repo: new FakeRepo(), token: { unit: 'u', ticker: 'X' }, denomination: 'ada', from: new Date(t0), to: new Date(t0 + 4 * day), log: noisy });
    expect(r.pages, 'one page to see the oldest row, one more to see it did not move').toBe(2);
    expect(warned.some((w) => 'oldest' in w)).toBe(true);
  });
});
