import { describe, expect, it } from 'vitest';
import { chooseExternalPool, GeckoTerminalClient, type GeckoPool } from '../src/index.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(responses: Array<() => Response>) {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra call');
    return next();
  }) as typeof fetch;
  return { f, calls };
}

const poolsBody = {
  data: [
    { id: 'cardano_aaa', attributes: { name: 'SNEK / ADA', address: 'aaa', reserve_in_usd: '100.5' }, relationships: { dex: { data: { id: 'minswap-cardano' } } } },
    { id: 'cardano_bbb', attributes: { name: 'NIGHT / SNEK', address: 'bbb', reserve_in_usd: '999' }, relationships: { dex: { data: { id: 'minswap-cardano' } } } },
    { id: 'cardano_ccc', attributes: { name: 'SNEK / ADA', address: 'ccc', reserve_in_usd: '50' }, relationships: { dex: { data: { id: 'saturnswap' } } } },
  ],
};

describe('GeckoTerminalClient', () => {
  it('lists only ADA pools, parses reserve, and spaces calls', async () => {
    const slept: number[] = [];
    const { f, calls } = fakeFetch([() => json(poolsBody), () => json(poolsBody)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async (ms) => { slept.push(ms); }, minSpacingMs: 3000, log });
    const pools = await c.listAdaPools('unit1');
    expect(pools.map((p) => p.hex)).toEqual(['aaa', 'ccc']);
    expect(pools[0]?.reserveUsd).toBe(100.5);
    expect(calls[0]).toContain('/networks/cardano/tokens/unit1/pools');
    await c.listAdaPools('unit1');
    expect(slept.length).toBe(1); // second call waited for the spacing window
    expect(c.calls()).toBe(2);
  });

  it('parses ohlcv rows into ascending decimal candles', async () => {
    const body = { data: { attributes: { ohlcv_list: [[1_788_692_700, 0.00218, 0.00223, 0.00218, 0.00222, 2272.72725], [1_788_692_400, 0.0021, 0.0022, 0.0021, 0.00218, 10]] } } };
    const { f, calls } = fakeFetch([() => json(body)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, log });
    const rows = await c.ohlcv5m('aaa', new Date(1_788_700_000 * 1000));
    expect(calls[0]).toContain('/pools/aaa/ohlcv/minute?aggregate=5&limit=1000&before_timestamp=1788700000');
    expect(rows.map((r) => r.tickTs.getTime() / 1000)).toEqual([1_788_692_400, 1_788_692_700]);
    expect(rows[1]?.close).toBe('0.00222');
    expect(rows[1]?.volumeQuote).toBe('2272.72725');
  });

  it('backs off on 429 and succeeds on a later attempt', async () => {
    const slept: number[] = [];
    const { f } = fakeFetch([() => json({}, 429), () => json({}, 429), () => json(poolsBody)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async (ms) => { slept.push(ms); }, minSpacingMs: 0, log });
    const pools = await c.listAdaPools('u');
    expect(pools).toHaveLength(2);
    expect(slept.length).toBe(2);
    expect(slept[0]).toBeGreaterThanOrEqual(5000);
    expect(slept[1]).toBeGreaterThan(slept[0]!);
  });

  it('gives up after 5 attempts with the status in the message', async () => {
    const { f } = fakeFetch(Array.from({ length: 5 }, () => () => json({}, 503)));
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, minSpacingMs: 0, log });
    await expect(c.listAdaPools('u')).rejects.toThrow(/503.*5 attempts/);
  });

  it('does not retry a 404', async () => {
    const { f, calls } = fakeFetch([() => json({}, 404)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, minSpacingMs: 0, log });
    await expect(c.ohlcv5m('nope')).rejects.toThrow(/404/);
    expect(calls).toHaveLength(1);
  });
});

describe('chooseExternalPool', () => {
  const pools: GeckoPool[] = [
    { id: 'cardano_aaa', hex: 'aaa', name: 'SNEK / ADA', dex: 'minswap-cardano', reserveUsd: 100 },
    { id: 'cardano_ccc', hex: 'ccc', name: 'SNEK / ADA', dex: 'saturnswap', reserveUsd: 500 },
  ];
  it('prefers an identifier match over a larger reserve', () => {
    expect(chooseExternalPool(pools, ['aaa'])).toEqual({ pool: pools[0], method: 'identifier' });
  });
  it('falls back to the largest reserve', () => {
    expect(chooseExternalPool(pools, ['zzz'])).toEqual({ pool: pools[1], method: 'pair_largest_reserve' });
  });
  it('returns null with no pools', () => {
    expect(chooseExternalPool([], [])).toBeNull();
  });
});
