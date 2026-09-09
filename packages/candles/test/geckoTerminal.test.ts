import { describe, expect, it } from 'vitest';
import { chooseExternalPool, GeckoTerminalClient, MAX_SPACING_MS, parseRetryAfter, type GeckoPool } from '../src/index.js';

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

// Finding I2: `ADA / SNEK` also contains 'ADA', but its OHLCV is quoted the other way round -- SNEK
// per ADA. Importing it as history silently inverts every price in the series.
const invertedPoolsBody = {
  data: [
    { id: 'cardano_ddd', attributes: { name: 'ADA / SNEK', address: 'ddd', reserve_in_usd: '9999' }, relationships: { dex: { data: { id: 'minswap-cardano' } } } },
    { id: 'cardano_aaa', attributes: { name: 'SNEK / ADA', address: 'aaa', reserve_in_usd: '100.5' }, relationships: { dex: { data: { id: 'minswap-cardano' } } } },
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

  it('keeps only pools with ADA as the QUOTE leg and warns about an inverted one', async () => {
    const warned: Array<Record<string, unknown>> = [];
    const noisy = { info: () => {}, warn: (o: Record<string, unknown>) => { warned.push(o); }, error: () => {} };
    const { f } = fakeFetch([() => json(invertedPoolsBody)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, minSpacingMs: 0, log: noisy });
    const pools = await c.listAdaPools('unit1');
    expect(pools.map((p) => p.hex), 'the deeper ADA / SNEK pool is skipped, not chosen').toEqual(['aaa']);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ pool: 'ddd', name: 'ADA / SNEK' });
  });

  it('parses ohlcv rows into ascending decimal candles', async () => {
    const body = { data: { attributes: { ohlcv_list: [[1_788_692_700, 0.00218, 0.00223, 0.00218, 0.00222, 2272.72725], [1_788_692_400, 0.0021, 0.0022, 0.0021, 0.00218, 10]] } } };
    const { f, calls } = fakeFetch([() => json(body)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, log });
    const rows = await c.ohlcv5m('aaa', new Date(1_788_700_000 * 1000));
    expect(calls[0]).toContain('/pools/aaa/ohlcv/minute?aggregate=5&limit=1000&currency=token&before_timestamp=1788700000');
    expect(rows.map((r) => r.tickTs.getTime() / 1000)).toEqual([1_788_692_400, 1_788_692_700]);
    expect(rows[1]?.close).toBe('0.00222');
    expect(rows[1]?.volumeQuote).toBe('2272.72725');
  });

  it('asks for the pool token by default, and only says usd when told to', async () => {
    // GeckoTerminal defaults `currency` to usd. Omitting the parameter -- which this client did until
    // 2026-09-09 -- silently imported dollars into a table read as if it held ADA, next to a cost
    // floor that is ADA-denominated. Verified live on the SNEK/ADA MinswapV2 pool, same 5-minute bar:
    // no parameter gave 0.000511568, `currency=token` gave 0.002337, which matches this project's own
    // reserve-derived close for that pool.
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(u); return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [] } } }) }; }) as unknown as typeof fetch;
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } });

    await c.ohlcv5m('aaa');
    await c.ohlcv5m('aaa', undefined, 'ada');
    await c.ohlcv5m('aaa', undefined, 'usd');

    expect(urls[0]).toContain('currency=token');   // default
    expect(urls[1]).toContain('currency=token');
    expect(urls[2]).not.toContain('currency=');    // usd is GeckoTerminal's own default
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

  it('retries a rejected fetch (DNS/reset/timeout) and succeeds once the network recovers', async () => {
    const slept: number[] = [];
    let n = 0;
    const f = (async () => {
      n++;
      if (n <= 2) throw new Error('getaddrinfo ENOTFOUND api.geckoterminal.com');
      return json(poolsBody);
    }) as typeof fetch;
    const c = new GeckoTerminalClient({ fetch: f, sleep: async (ms) => { slept.push(ms); }, minSpacingMs: 0, log });
    const pools = await c.listAdaPools('u');
    expect(pools).toHaveLength(2);
    expect(slept.length).toBe(2);
    expect(c.calls()).toBe(3);
  });

  it('gives up after 5 attempts on a fetch that always rejects', async () => {
    const f = (async () => { throw new Error('ECONNRESET'); }) as typeof fetch;
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, minSpacingMs: 0, log });
    await expect(c.listAdaPools('u')).rejects.toThrow(/network error.*5 attempts/);
  });
});

describe('GeckoTerminalClient adaptive spacing (2026-09-07 universe backfill: 118 rate limits at 3 s)', () => {
  const ohlcv = () => json({ data: { attributes: { ohlcv_list: [] } } });
  it('doubles the spacing on a 429 (capped), honors Retry-After as the floor of the wait, and decays back toward the base on successes', async () => {
    const slept: number[] = [];
    const { f } = fakeFetch([
      () => json({}, 429), ohlcv, // widen 3000 -> 6000
      () => new Response('{}', { status: 429, headers: { 'retry-after': '20' } }), ohlcv, // widen to max(12000, 20000) = 20000; wait >= 20000
      ohlcv, ohlcv, ohlcv,
    ]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async (ms) => { slept.push(ms); }, minSpacingMs: 3_000, log, random: () => 0 });
    expect(c.currentSpacingMs()).toBe(3_000);
    await c.ohlcv5m('p'); // 429 then ok
    expect(slept[0]).toBe(5_000); // retry backoff
    // success decays: 6000 * 0.85 = 5100
    expect(c.currentSpacingMs()).toBe(5_100);
    await c.ohlcv5m('p'); // 429 with Retry-After 20 s, then ok
    expect(slept.some((ms) => ms >= 20_000)).toBe(true);
    // widened to 20000 then one success decays to 17000
    expect(c.currentSpacingMs()).toBe(17_000);
    await c.ohlcv5m('p'); await c.ohlcv5m('p'); await c.ohlcv5m('p');
    expect(c.currentSpacingMs()).toBeLessThan(17_000);
    expect(c.currentSpacingMs()).toBeGreaterThanOrEqual(3_000);
  });
  it('never widens past MAX_SPACING_MS and never decays below the base', async () => {
    const { f } = fakeFetch([() => json({}, 429), () => json({}, 429), () => json({}, 429), () => json({}, 429), ohlcv, ...Array.from({ length: 40 }, () => ohlcv)]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, minSpacingMs: 3_000, log, random: () => 0 });
    await c.ohlcv5m('p'); // four 429s then ok: 6000, 12000, 24000, 30000 (cap), then one decay
    expect(c.currentSpacingMs()).toBe(Math.round(MAX_SPACING_MS * 0.85));
    for (let i = 0; i < 40; i++) await c.ohlcv5m('p');
    expect(c.currentSpacingMs()).toBe(3_000);
  });
  it('a 5xx backs off the call but does not widen the spacing (it is not a rate limit)', async () => {
    const { f } = fakeFetch([() => json({}, 503), ohlcv]);
    const c = new GeckoTerminalClient({ fetch: f, sleep: async () => {}, minSpacingMs: 3_000, log, random: () => 0 });
    await c.ohlcv5m('p');
    expect(c.currentSpacingMs()).toBe(3_000);
  });
  it('parseRetryAfter reads seconds and ignores anything else', () => {
    expect(parseRetryAfter('20')).toBe(20_000);
    expect(parseRetryAfter(' 1.5 ')).toBe(1_500);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfter('-3')).toBeNull();
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
