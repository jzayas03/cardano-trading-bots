import { Socket } from 'node:net';
import type { RunRow, RunSummaryStats } from '@ctb/engine';
import { checkEnv, type DigestInput } from '@ctb/reports';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunFilter } from '../src/reads.js';
import { createDashboardServer, listen, type DashboardDeps } from '../src/server.js';

/**
 * `fetch`/WHATWG `URL` cannot even construct a request for a malformed target like `//` or `//runs`
 * — that reinterpretation (or rejection) is exactly what Critical 1 is about — and Node's own
 * `http.request` client-side-validates its `path` option and refuses one containing a raw space
 * (`Request path contains unescaped characters`), which would silently exclude the `//a b` case Node's
 * own HTTP *server* parser is documented to forward untouched. A raw TCP socket writing the request
 * line by hand is the only way to reproduce exactly what a real malformed client sends on the wire.
 */
function rawRequest(port: number, rawTarget: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const socket = new Socket();
    let data = '';
    socket.on('error', reject);
    socket.connect(port, '127.0.0.1', () => {
      socket.write(`${method} ${rawTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); });
    socket.on('end', () => {
      const statusLine = data.split('\r\n')[0] ?? '';
      const status = Number(statusLine.split(' ')[1] ?? '0');
      const body = data.slice(data.indexOf('\r\n\r\n') + 4);
      resolvePromise({ status, body });
    });
  });
}

const digestFixture: DigestInput = {
  intervalSec: 600,
  lastFinished: { tickTs: new Date('2026-09-07T12:00:00Z'), finishedAt: new Date('2026-09-07T12:01:30Z'), poolsWritten: 20, poolsFailed: 0, providerCalls: 210, discovered: false },
  ticksLast24h: 70, discoveryCallsToday: 5_691, refreshCallsToday: 9_309, lastDiscoveryAt: new Date('2026-09-07T00:10:00Z'), poolFailures24h: 0, venueErrors24h: 0, unfinishedRuns: 0,
  venuesConfigured: ['MinswapV2', 'SundaeSwapV3'], venuesSinceLastDiscovery: ['MinswapV2', 'SundaeSwapV3'], venuesInLastTick: ['MinswapV2', 'SundaeSwapV3'], tokensTotal: 20, tokensCoveredInLastTick: 20,
};

function makeRun(overrides: Partial<RunRow>): RunRow {
  return {
    id: 1, mode: 'paper', strategyId: 'buyAndHold', params: {}, gitSha: 'abc1234', baseUnit: 'testtoken.abcd',
    dataSource: 'candles', fillModel: 'cpmm_observed', dataFrom: new Date('2026-09-01T00:00:00Z'), dataTo: new Date('2026-09-07T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'), finishedAt: null, summary: null, status: 'running',
    heartbeatAt: new Date('2026-09-07T12:00:00Z'), lastTickTs: new Date('2026-09-07T12:00:00Z'), stopReason: null, rehearsal: false,
    ...overrides,
  };
}

const backtestSummary: RunSummaryStats = {
  candles: 100, intents: 5, filled: 4, rejected: 1,
  startEquityLovelace: '1000000000', endEquityLovelace: '1032000000', returnPct: 3.2, maxDrawdownPct: 1.1,
  feesLovelace: '8000000', poolFeesIn: '40000000', rejectReasons: { dust: 1 },
  coverage: { candles: 100, first: '2026-09-01T00:00:00.000Z', last: '2026-09-05T00:00:00.000Z', expectedBuckets: 100, maxGapMs: 600_000, gapsOverBound: 0 },
  warnings: [],
};

const paperRun = makeRun({ id: 1 });
const backtestRun = makeRun({ id: 2, mode: 'backtest', strategyId: 'rsi-mean-reversion', status: 'finished', finishedAt: new Date('2026-09-05T00:00:00Z'), summary: backtestSummary });
const rehearsalRun = makeRun({ id: 3, rehearsal: true, stopReason: 'operator stop' });
const runsById = new Map<number, RunRow>([[1, paperRun], [2, backtestRun], [3, rehearsalRun]]);

function makeDeps(): DashboardDeps {
  return {
    reads: { listRuns: async () => [paperRun, backtestRun] },
    runs: {
      getRun: async (id: number) => runsById.get(id) ?? null,
      listOrders: async () => [],
      listEquity: async () => [],
    },
    collector: { digestInput: async () => digestFixture },
    processes: () => [{ pid: 111, command: '/usr/local/bin/node /repo/packages/cli/src/main.ts collect' }],
    migrations: async () => ({ onDisk: ['0001_init.sql'], applied: ['0001_init.sql'] }),
    fakeRows: async () => ({ snapshots: 0, candles: 0 }),
    // Reads live `process.env` at call time (mirroring the real CLI wiring in commands/dashboard.ts),
    // so the "no secret in any body" assertion below actually exercises the env-value path instead of
    // vacuously passing on a stub that never touches process.env at all.
    envChecks: () => checkEnv(process.env),
    tickerOf: (unit: string) => (unit === 'testtoken.abcd' ? 'TEST' : unit),
    unitOf: (ticker: string) => (ticker === 'TEST' ? 'testtoken.abcd' : undefined),
    tickers: () => ['TEST'],
    intervalSec: 600,
    venues: ['MinswapV2', 'SundaeSwapV3'],
    now: () => new Date('2026-09-07T12:05:00Z'),
    log: { info: () => {}, error: () => {} },
  };
}

describe('createDashboardServer / listen', () => {
  let originalBlockfrost: string | undefined;
  let originalDatabaseUrl: string | undefined;

  afterEach(() => {
    if (originalBlockfrost === undefined) delete process.env.BLOCKFROST_PROJECT_ID; else process.env.BLOCKFROST_PROJECT_ID = originalBlockfrost;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('binds 127.0.0.1 only, routes every path to the right status/content-type, and never leaks a fake .env value', async () => {
    originalBlockfrost = process.env.BLOCKFROST_PROJECT_ID;
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.BLOCKFROST_PROJECT_ID = 'SECRETVALUE';
    process.env.DATABASE_URL = 'postgres://u:SECRETPASS@h/d';

    const server = createDashboardServer(makeDeps());
    const { url } = await listen(server, 0);
    try {
      const addr = server.address();
      expect(addr).not.toBeNull();
      expect(typeof addr).toBe('object');
      if (addr && typeof addr === 'object') expect(addr.address).toBe('127.0.0.1');

      const cases: Array<{ method: string; path: string; status: number; contentType: string }> = [
        { method: 'GET', path: '/', status: 200, contentType: 'text/html' },
        { method: 'GET', path: '/runs', status: 200, contentType: 'text/html' },
        { method: 'GET', path: '/runs/1', status: 200, contentType: 'text/html' },
        { method: 'GET', path: '/runs/999', status: 404, contentType: 'text/html' },
        { method: 'GET', path: '/runs/abc', status: 400, contentType: 'text/html' },
        { method: 'GET', path: '/nope', status: 404, contentType: 'text/html' },
        { method: 'GET', path: '/vendor/uPlot.min.css', status: 200, contentType: 'text/css' },
        // Finding: the previous version of this list stopped at the CSS vendor file and never fetched
        // the 51 KB JS one — the larger of the two vendor bodies never got a secret-leak check at all.
        { method: 'GET', path: '/vendor/uPlot.iife.min.js', status: 200, contentType: 'text/javascript' },
        { method: 'POST', path: '/', status: 405, contentType: 'text/plain' },
      ];

      const bodies: string[] = [];
      for (const c of cases) {
        const res = await fetch(new URL(c.path, url), { method: c.method });
        expect(res.status, `${c.method} ${c.path}`).toBe(c.status);
        expect(res.headers.get('content-type') ?? '', `${c.method} ${c.path} content-type`).toMatch(new RegExp(`^${c.contentType}`));
        if (c.status === 405) expect(res.headers.get('allow'), `${c.method} ${c.path} Allow header (RFC 9110)`).toBe('GET');
        bodies.push(await res.text());
      }

      // NOTE on scope: this loop can only catch a secret that reaches a response body — a direct
      // `process.env` read from page code, or one threaded through via `envChecks`/digest/etc. It
      // cannot prove there is no OTHER path a secret could take (a log line forwarded into a body by
      // some future handler, for instance); it is a floor, not a ceiling, on what "never rendered" means.
      for (const body of bodies) {
        expect(body).not.toContain('SECRETVALUE');
        expect(body).not.toContain('SECRETPASS');
      }
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('answers HEAD with 405 too, since only GET is routed', async () => {
    const server = createDashboardServer(makeDeps());
    const { url } = await listen(server, 0);
    try {
      const res = await fetch(new URL('/', url), { method: 'HEAD' });
      expect(res.status).toBe(405);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('renders the REHEARSAL banner on a run detail page for a rehearsal run', async () => {
    const server = createDashboardServer(makeDeps());
    const { url } = await listen(server, 0);
    try {
      const res = await fetch(new URL('/runs/3', url));
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain('REHEARSAL');
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  // Critical 1: `new URL(req.url ?? '/', 'http://127.0.0.1')` used to sit outside any try/catch, and
  // `void handleRequest(...)` had no `.catch()` — Node's own HTTP parser forwards a request target like
  // `//`, `//%`, `//[`, or `/\` without complaint, `new URL()` then throws synchronously, and the
  // resulting unhandled rejection crashed the whole process (reproduced live: exit code 1). Every case
  // here must answer 400 AND the server must still be alive and serving `/` immediately afterward.
  it('answers 400 (not a crashed process) for every malformed request target Node\'s HTTP parser forwards untouched', async () => {
    const server = createDashboardServer(makeDeps());
    const { port } = await listen(server, 0);
    try {
      for (const target of ['//', '//%', '//[', '/\\', '//a b']) {
        const res = await rawRequest(port, target);
        expect(res.status, `target ${JSON.stringify(target)}`).toBe(400);
      }
      // The process — and this same server instance — is still serving requests normally.
      const healthy = await rawRequest(port, '/');
      expect(healthy.status).toBe(200);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  // Critical 1, second half: `new URL('//runs', base)` does NOT throw — WHATWG reads `runs` as a HOST
  // (protocol-relative), so `pathname` comes back as `/` and the request would silently alias the
  // health page instead of ever reaching the router's `/runs` case. `//runs` must be REJECTED, not
  // served as anything — least of all as the health page.
  it('rejects GET //runs outright — it must never silently alias the health page at /', async () => {
    const server = createDashboardServer(makeDeps());
    const { port } = await listen(server, 0);
    try {
      const res = await rawRequest(port, '//runs');
      expect(res.status).toBe(400);
      expect(res.body).not.toContain('<h2>Digest'); // the health page's own section heading
      const healthy = await rawRequest(port, '/');
      expect(healthy.status).toBe(200);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('/runs translates ?mode=&strategy=&ticker=&status=&page= into a RunFilter and pagination offset', async () => {
    const deps = makeDeps();
    const calls: Array<{ filter: RunFilter; limit: number; offset: number }> = [];
    deps.reads = { listRuns: async (filter, limit, offset) => { calls.push({ filter, limit, offset }); return [paperRun]; } };
    const server = createDashboardServer(deps);
    const { url } = await listen(server, 0);
    try {
      const res = await fetch(new URL('/runs?mode=paper&strategy=buyAndHold&ticker=TEST&status=running&page=2', url));
      expect(res.status).toBe(200);
      expect(calls).toEqual([{ filter: { mode: 'paper', strategy: 'buyAndHold', unit: 'testtoken.abcd', status: 'running' }, limit: 50, offset: 50 }]);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('/runs with no query at all filters on nothing and reads page 1', async () => {
    const deps = makeDeps();
    const calls: Array<{ filter: RunFilter; limit: number; offset: number }> = [];
    deps.reads = { listRuns: async (filter, limit, offset) => { calls.push({ filter, limit, offset }); return []; } };
    const server = createDashboardServer(deps);
    const { url } = await listen(server, 0);
    try {
      await fetch(new URL('/runs', url));
      expect(calls).toEqual([{ filter: { mode: undefined, strategy: undefined, unit: undefined, status: undefined }, limit: 50, offset: 0 }]);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it.each([
    ['mode', 'bogus', 'backtest, paper'],
    ['status', 'bogus', 'running, finished, aborted'],
  ])('/runs?%s=%s is refused with 400 naming the accepted values', async (field, value, accepted) => {
    const server = createDashboardServer(makeDeps());
    const { url } = await listen(server, 0);
    try {
      const res = await fetch(new URL(`/runs?${field}=${value}`, url));
      const body = await res.text();
      expect(res.status).toBe(400);
      expect(body).toContain(accepted);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('/runs?ticker=NOPE is refused with 400 — an unrecognised ticker must not silently match nothing', async () => {
    const server = createDashboardServer(makeDeps());
    const { url } = await listen(server, 0);
    try {
      const res = await fetch(new URL('/runs?ticker=NOPE', url));
      const body = await res.text();
      expect(res.status).toBe(400);
      expect(body).toContain('NOPE');
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  // Finding M1 (review round 1): `1e21` has no fractional part and isn't negative, so it slipped past
  // `Number.isInteger`/`n < 1` and reached the SQL OFFSET parameter as `(1e21 - 1) * PAGE_SIZE` —
  // Postgres then rejected the out-of-range integer with a 500, not the 400 every other bad query
  // value on this route gets. `2000000` exceeds the new `MAX_PAGE` ceiling while still being a
  // perfectly safe, in-range integer, proving the ceiling check fires on its own (not merely riding on
  // `Number.isSafeInteger`).
  it.each(['0', '-1', 'abc', '1.5', '1e21', '2000000'])('/runs?page=%s is refused with 400', async (page) => {
    const server = createDashboardServer(makeDeps());
    const { url } = await listen(server, 0);
    try {
      const res = await fetch(new URL(`/runs?page=${page}`, url));
      expect(res.status).toBe(400);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  // IMPORTANT 3 (final review): the identical defect as Finding M1 above, on the run-id path this time.
  // `999999999999999999999` (23 digits) is all-digits, so it passed `/^\d+$/`, but `Number(...)` gives
  // `1e+21` — far past `Number.isSafeInteger` — which reached Postgres as a bigint parameter and got a
  // 500 (`invalid input syntax for type bigint: "1e+21"`), not the 400 every other bad parameter here
  // gets.
  it('/runs/999999999999999999999 (oversized id) is refused with 400, not a 500 from Postgres', async () => {
    const server = createDashboardServer(makeDeps());
    const { url } = await listen(server, 0);
    try {
      const res = await fetch(new URL('/runs/999999999999999999999', url));
      expect(res.status).toBe(400);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('/runs/2 (a backtest) says equity is not persisted and shows the runs.summary headline', async () => {
    const server = createDashboardServer(makeDeps());
    const { url } = await listen(server, 0);
    try {
      const res = await fetch(new URL('/runs/2', url));
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain('equity is not persisted for backtest runs');
      expect(body).toContain('rsi-mean-reversion');
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('/runs/1 (a paper run) does not say equity is not persisted', async () => {
    const server = createDashboardServer(makeDeps());
    const { url } = await listen(server, 0);
    try {
      const res = await fetch(new URL('/runs/1', url));
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).not.toContain('equity is not persisted');
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  // IMPORTANT 2: a thrown handler error (e.g. a failing DB dependency) previously rendered
  // `err.message` verbatim — a connection string with credentials once reached the page this way.
  it('returns 500 for a throwing handler dependency without the thrown message appearing in the body (it goes to the log instead)', async () => {
    const deps = makeDeps();
    const secretMessage = 'connect ECONNREFUSED postgres://ctb_dashboard:SUPERSECRETPW@localhost:5433/ctb';
    deps.collector = { digestInput: async () => { throw new Error(secretMessage); } };
    const loggedErrors: string[] = [];
    deps.log = { info: () => {}, error: (o) => loggedErrors.push(JSON.stringify(o)) };

    const server = createDashboardServer(deps);
    const { url } = await listen(server, 0);
    try {
      const res = await fetch(new URL('/', url));
      const body = await res.text();
      expect(res.status).toBe(500);
      expect(body).not.toContain(secretMessage);
      expect(body).not.toContain('SUPERSECRETPW');
      expect(body).toContain('internal error');
      // The real message still goes exactly where it always did: the log, never the response.
      expect(loggedErrors.some((l) => l.includes('SUPERSECRETPW'))).toBe(true);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
