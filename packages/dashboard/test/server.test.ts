import type { RunRow } from '@ctb/engine';
import type { DigestInput } from '@ctb/reports';
import { afterEach, describe, expect, it } from 'vitest';
import { createDashboardServer, listen, type DashboardDeps } from '../src/server.js';

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

const paperRun = makeRun({ id: 1 });
const backtestRun = makeRun({ id: 2, mode: 'backtest', status: 'finished', finishedAt: new Date('2026-09-05T00:00:00Z'), summary: { returnPct: 3.2 } as unknown as RunRow['summary'] });
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
    tickerOf: (unit: string) => (unit === 'testtoken.abcd' ? 'TEST' : unit),
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
        { method: 'POST', path: '/', status: 405, contentType: 'text/plain' },
      ];

      const bodies: string[] = [];
      for (const c of cases) {
        const res = await fetch(new URL(c.path, url), { method: c.method });
        expect(res.status, `${c.method} ${c.path}`).toBe(c.status);
        expect(res.headers.get('content-type') ?? '', `${c.method} ${c.path} content-type`).toMatch(new RegExp(`^${c.contentType}`));
        bodies.push(await res.text());
      }

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
});
