import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunRepo } from '@ctb/engine';
import { checkFakeRows, checkMigrations, checkProcesses, digestLines, type Check, type DigestInput, type ProcessLine } from '@ctb/reports';
import { escape, layout } from './html.js';
import { renderHealth } from './pages/health.js';
import type { DashboardReads } from './reads.js';

const VENDOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor');

export interface DashboardDeps {
  /** Task 5's `PgDashboardReads`; Task 4 stubs it with `{ listRuns: async () => [] }` in tests and in
   *  the CLI command (see `commands/dashboard.ts`) until that lands. */
  reads: DashboardReads;
  runs: Pick<RunRepo, 'getRun' | 'listOrders' | 'listEquity'>;
  collector: { digestInput(intervalSec: number, venues: string[], now: Date): Promise<DigestInput> };
  /** Injected so the trap cases (two collectors, a stopped fake collector) are unit-testable without a machine. */
  processes: () => ProcessLine[];
  migrations: () => Promise<{ onDisk: string[]; applied: string[] }>;
  fakeRows: () => Promise<{ snapshots: number; candles: number }>;
  tickerOf: (unit: string) => string;
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

async function vendorFile(filename: string, contentType: string): Promise<HandlerResult> {
  const body = await readFile(resolve(VENDOR_DIR, filename), 'utf8');
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
  ];
  return htmlPage(200, renderHealth({ digest, checks, now }));
}

/**
 * `/runs`: a bare listing over `DashboardReads.listRuns` — no arithmetic, just the raw run fields.
 * Task 5 replaces this with the full filterable page (spec §4.2); this exists now only so the route
 * table and its status codes (spec §6) can be built and smoke-tested in this task.
 */
async function runsHandler(deps: DashboardDeps): Promise<HandlerResult> {
  const runs = await deps.reads.listRuns({}, 200, 0);
  const rows = runs.map((r) => [
    r.id, r.mode, r.strategyId, deps.tickerOf(r.baseUnit), r.status, r.createdAt.toISOString(), r.rehearsal ? 'REHEARSAL' : '',
  ]);
  const body = rows.length === 0
    ? '<p class="empty">none</p>'
    : `<table><thead><tr><th>id</th><th>mode</th><th>strategy</th><th>ticker</th><th>status</th><th>created</th><th></th></tr></thead>` +
      `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escape(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const rehearsal = runs.some((r) => r.rehearsal);
  return htmlPage(200, layout('Runs', body, { rehearsal }));
}

/** `/runs/:id`: a non-integer id is a 400 (spec §6, "never a silent default"); a missing run is a 404. */
async function runDetailHandler(deps: DashboardDeps, idParam: string, path: string): Promise<HandlerResult> {
  if (!/^\d+$/.test(idParam)) return badRequest(path, `invalid run id ${JSON.stringify(idParam)}: must be a non-negative integer`);
  const id = Number(idParam);
  const run = await deps.runs.getRun(id);
  if (!run) return notFound(path);
  const body = `<dl>
    <dt>mode</dt><dd>${escape(run.mode)}</dd>
    <dt>strategy</dt><dd>${escape(run.strategyId)}</dd>
    <dt>ticker</dt><dd>${escape(deps.tickerOf(run.baseUnit))}</dd>
    <dt>status</dt><dd>${escape(run.status)}</dd>
    <dt>git sha</dt><dd>${escape(run.gitSha)}</dd>
    <dt>created</dt><dd>${escape(run.createdAt.toISOString())}</dd>
    <dt>finished</dt><dd>${run.finishedAt ? escape(run.finishedAt.toISOString()) : '-'}</dd>
    <dt>stop reason</dt><dd>${run.stopReason ? escape(run.stopReason) : '-'}</dd>
  </dl>
  <p class="empty">full run detail (equity chart, orders, headline) lands in Task 5.</p>`;
  return htmlPage(200, layout(`Run #${id}`, body, { rehearsal: run.rehearsal }));
}

function send(res: ServerResponse, result: HandlerResult): void {
  res.writeHead(result.status, { 'content-type': result.contentType, ...result.headers });
  res.end(result.body);
}

async function route(deps: DashboardDeps, url: URL): Promise<HandlerResult> {
  const path = url.pathname;
  if (path === '/') return healthHandler(deps);
  if (path === '/runs') return runsHandler(deps);
  if (path === '/vendor/uPlot.iife.min.js') return vendorFile('uPlot.iife.min.js', 'text/javascript; charset=utf-8');
  if (path === '/vendor/uPlot.min.css') return vendorFile('uPlot.min.css', 'text/css; charset=utf-8');
  const runIdMatch = /^\/runs\/([^/]+)$/.exec(path);
  if (runIdMatch) return runDetailHandler(deps, runIdMatch[1]!, path);
  return notFound(path);
}

/** Not yet listening — call `listen()` to bind. */
export function createDashboardServer(deps: DashboardDeps): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(deps, req, res);
  });
}

async function handleRequest(deps: DashboardDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'GET') {
    send(res, { status: 405, body: 'method not allowed', contentType: 'text/plain; charset=utf-8' });
    return;
  }
  try {
    send(res, await route(deps, url));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.error({ err: message, route: url.pathname }, 'dashboard handler failed');
    send(res, errorPage(500, url.pathname, message));
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
