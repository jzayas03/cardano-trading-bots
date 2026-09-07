import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunRepo } from '@ctb/engine';
import { checkFakeRows, checkMigrations, checkProcesses, digestLines, type Check, type DigestInput, type ProcessLine } from '@ctb/reports';
import { escape, layout } from './html.js';
import { renderHealth } from './pages/health.js';
import { renderRunDetail, renderRunsList } from './pages/runs.js';
import { RUN_MODES, RUN_STATUSES, type DashboardReads, type RunFilter } from './reads.js';

const VENDOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor');

export interface DashboardDeps {
  /** `PgDashboardReads` in production (see `commands/dashboard.ts`); a literal `{ listRuns: async
   *  () => [] }` in tests that don't exercise `/runs`. */
  reads: DashboardReads;
  runs: Pick<RunRepo, 'getRun' | 'listOrders' | 'listEquity'>;
  collector: { digestInput(intervalSec: number, venues: string[], now: Date): Promise<DigestInput> };
  /** Injected so the trap cases (two collectors, a stopped fake collector) are unit-testable without a machine. */
  processes: () => ProcessLine[];
  migrations: () => Promise<{ onDisk: string[]; applied: string[] }>;
  fakeRows: () => Promise<{ snapshots: number; candles: number }>;
  /** `checkEnv(process.env)`, computed once by the CLI command (never inside this package — this
   *  package never reads `process.env`) and handed in so the health page can show the Blockfrost key
   *  by length like `doctor` does. */
  envChecks: () => Check[];
  tickerOf: (unit: string) => string;
  /** The other direction of `tickerOf`, for `/runs?ticker=`: a pure universe lookup, never a query.
   *  Undefined for a ticker the universe doesn't recognise, which `/runs` turns into a 400 (a typo'd
   *  ticker must not silently render as "no filter" — that would show every run instead of none). */
  unitOf: (ticker: string) => string | undefined;
  intervalSec: number;
  venues: string[];
  now: () => Date;
  log: { info(o: object, m: string): void; error(o: object, m: string): void };
}

interface HandlerResult {
  status: number;
  body: string;
  contentType: string;
  headers?: Record<string, string>;
}

function htmlPage(status: number, body: string): HandlerResult {
  return { status, body, contentType: 'text/html; charset=utf-8' };
}

/** Used for 400/404, whose message is always a string this file constructed itself — never an
 * exception's own text (see `internalErrorPage` below, which is the one that must never do that). */
function errorPage(status: number, path: string, message: string): HandlerResult {
  const body = layout('Error', `<p>Route: ${escape(path)}</p><pre>${escape(message)}</pre>`);
  return htmlPage(status, body);
}

function notFound(path: string): HandlerResult {
  return errorPage(404, path, `not found: ${path}`);
}

function badRequest(path: string, message: string): HandlerResult {
  return errorPage(400, path, message);
}

/**
 * A thrown handler error (e.g. a failing database dependency) previously rendered `err.message`
 * verbatim into the body — a connection string with credentials once ended up on the page this way.
 * "Secrets are never rendered" is one of this package's three load-bearing properties, so the body
 * here is a fixed string; the real message goes only to `deps.log.error`, where it already went.
 */
function internalErrorPage(path: string): HandlerResult {
  const body = layout('Error', `<p>Route: ${escape(path)}</p><p>internal error — see the dashboard log</p>`);
  return htmlPage(500, body);
}

// uPlot's two vendor files are static for the life of the process; re-reading 51 KB off disk on
// every request was needless I/O. Cached on first request, per filename.
const vendorCache = new Map<string, string>();

async function vendorFile(filename: string, contentType: string): Promise<HandlerResult> {
  let body = vendorCache.get(filename);
  if (body === undefined) {
    body = await readFile(resolve(VENDOR_DIR, filename), 'utf8');
    vendorCache.set(filename, body);
  }
  return { status: 200, body, contentType, headers: { 'cache-control': 'max-age=86400' } };
}

/** `/`: the digest as a status board, plus the doctor's process, migration and rehearsal-data checks. */
async function healthHandler(deps: DashboardDeps): Promise<HandlerResult> {
  const now = deps.now();
  const digestInput = await deps.collector.digestInput(deps.intervalSec, deps.venues, now);
  const digest = digestLines(digestInput, now);
  const migrations = await deps.migrations();
  const fake = await deps.fakeRows();
  const checks: Check[] = [
    ...checkProcesses(deps.processes(), process.pid),
    checkMigrations(migrations.onDisk, migrations.applied),
    checkFakeRows(fake.snapshots, fake.candles),
    ...deps.envChecks(),
  ];
  return htmlPage(200, renderHealth({ digest, checks, now }));
}

const PAGE_SIZE = 50;

/** Thrown only inside `parseRunsQuery` for a bad query value; caught in `runsHandler` and turned
 * into a 400 that names the accepted values (spec §6, "never a silent default"). */
class RunsQueryError extends Error {}

function parseEnumParam<T extends string>(raw: string | null, accepted: readonly T[], field: string): T | undefined {
  if (raw === null || raw === '') return undefined;
  if (!(accepted as readonly string[]).includes(raw)) {
    throw new RunsQueryError(`${field} must be one of ${accepted.join(', ')}; got ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

/**
 * `?mode=&strategy=&ticker=&status=&page=`. `mode`/`status` are validated against the same enums
 * `PgDashboardReads` accepts; an unrecognised `ticker` is refused rather than silently matching
 * nothing (a typo must not read as "no filter" — that would show every run instead of none).
 */
function parseRunsQuery(deps: DashboardDeps, url: URL): { filter: RunFilter; page: number } {
  const params = url.searchParams;
  const mode = parseEnumParam(params.get('mode'), RUN_MODES, 'mode');
  const status = parseEnumParam(params.get('status'), RUN_STATUSES, 'status');
  const strategyRaw = params.get('strategy');
  const strategy = strategyRaw !== null && strategyRaw !== '' ? strategyRaw : undefined;
  const tickerRaw = params.get('ticker');
  let unit: string | undefined;
  if (tickerRaw !== null && tickerRaw !== '') {
    unit = deps.unitOf(tickerRaw);
    if (unit === undefined) throw new RunsQueryError(`ticker ${JSON.stringify(tickerRaw)} is not a recognized ticker`);
  }
  const pageRaw = params.get('page');
  let page = 1;
  if (pageRaw !== null && pageRaw !== '') {
    const n = Number(pageRaw);
    if (!Number.isInteger(n) || n < 1) throw new RunsQueryError(`page must be an integer >= 1; got ${JSON.stringify(pageRaw)}`);
    page = n;
  }
  return { filter: { mode, strategy, unit, status }, page };
}

/** `/runs`: the filterable list (spec §4.2). Every number on the page is `runs.summary`, already
 * computed once by the engine at finish time — this handler never loads a run's equity or orders
 * (see `pages/runs.ts`'s file header), so a page of 50 runs is exactly one query. */
async function runsHandler(deps: DashboardDeps, url: URL, path: string): Promise<HandlerResult> {
  let query: { filter: RunFilter; page: number };
  try {
    query = parseRunsQuery(deps, url);
  } catch (err) {
    if (err instanceof RunsQueryError) return badRequest(path, err.message);
    throw err;
  }
  const offset = (query.page - 1) * PAGE_SIZE;
  const runs = await deps.reads.listRuns(query.filter, PAGE_SIZE, offset);
  const body = renderRunsList({ runs, tickerOf: deps.tickerOf, filter: query.filter, page: query.page, pageSize: PAGE_SIZE, now: deps.now() });
  return htmlPage(200, body);
}

/**
 * `/runs/:id`: a non-integer id is a 400 (spec §6, "never a silent default"); a missing run is a
 * 404. Orders and equity are fetched in parallel — `listEquity` from the epoch so a resumed run's
 * earliest points (which can predate `runs.created_at` — see `report.ts`'s own comment on this) are
 * never silently dropped.
 */
async function runDetailHandler(deps: DashboardDeps, idParam: string, path: string): Promise<HandlerResult> {
  if (!/^\d+$/.test(idParam)) return badRequest(path, `invalid run id ${JSON.stringify(idParam)}: must be a non-negative integer`);
  const id = Number(idParam);
  const run = await deps.runs.getRun(id);
  if (!run) return notFound(path);
  const now = deps.now();
  const [orders, equity] = await Promise.all([deps.runs.listOrders(id), deps.runs.listEquity(id, new Date(0), now)]);
  const body = renderRunDetail({ run, ticker: deps.tickerOf(run.baseUnit), orders, equity, now });
  return htmlPage(200, body);
}

function send(res: ServerResponse, result: HandlerResult): void {
  res.writeHead(result.status, { 'content-type': result.contentType, ...result.headers });
  res.end(result.body);
}

async function route(deps: DashboardDeps, url: URL): Promise<HandlerResult> {
  const path = url.pathname;
  if (path === '/') return healthHandler(deps);
  if (path === '/runs') return runsHandler(deps, url, path);
  if (path === '/vendor/uPlot.iife.min.js') return vendorFile('uPlot.iife.min.js', 'text/javascript; charset=utf-8');
  if (path === '/vendor/uPlot.min.css') return vendorFile('uPlot.min.css', 'text/css; charset=utf-8');
  const runIdMatch = /^\/runs\/([^/]+)$/.exec(path);
  if (runIdMatch) return runDetailHandler(deps, runIdMatch[1]!, path);
  return notFound(path);
}

/** Not yet listening — call `listen()` to bind. */
export function createDashboardServer(deps: DashboardDeps): http.Server {
  return http.createServer((req, res) => {
    // Defense in depth (Critical 1): `handleRequest` already catches everything it can throw, including
    // a malformed `req.url` that `new URL()` rejects. This `.catch()` exists so that if a future edit
    // ever adds code ABOVE that try block, it still cannot repeat the 2026-09-07 crash where an
    // unhandled rejection from a bad request target (Node forwards `//`, `//%`, `//[`, `/\`,
    // absolute-form targets with an invalid host, etc. — its own HTTP parser never rejects them) took
    // the whole process down.
    handleRequest(deps, req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.error({ err: message, route: req.url ?? '/' }, 'dashboard handler failed outside its own try/catch');
      if (!res.headersSent) send(res, internalErrorPage(req.url ?? '/'));
      else res.end();
    });
  });
}

async function handleRequest(deps: DashboardDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = req.url ?? '/';
  try {
    if (req.method !== 'GET') {
      send(res, { status: 405, body: 'method not allowed', contentType: 'text/plain; charset=utf-8', headers: { allow: 'GET' } });
      return;
    }
    // `new URL('//runs', base)` parses successfully — WHATWG treats a leading `//` as protocol-relative
    // and reads what follows as a HOST, not a path segment, so `pathname` silently comes back as `/`
    // and the request would alias the health page instead of 404ing or erroring. Reject any
    // `//`-prefixed target outright, before `new URL` gets a chance to reinterpret it.
    if (raw.startsWith('//')) {
      send(res, badRequest(raw, `malformed request target ${JSON.stringify(raw)}: a '//'-prefixed target is rejected, not reinterpreted as a host`));
      return;
    }
    let url: URL;
    try {
      url = new URL(raw, 'http://127.0.0.1');
    } catch {
      send(res, badRequest(raw, `malformed request target ${JSON.stringify(raw)}`));
      return;
    }
    send(res, await route(deps, url));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.error({ err: message, route: raw }, 'dashboard handler failed');
    send(res, internalErrorPage(raw));
  }
}

/** Binds `127.0.0.1` only — not configurable — so a caller can never accidentally expose this off the
 * host. `port: 0` lets the OS pick a free port (used by tests). */
export function listen(server: http.Server, port: number): Promise<{ port: number; url: string }> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('dashboard server has no network address after listen()'));
        return;
      }
      resolvePromise({ port: addr.port, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}
