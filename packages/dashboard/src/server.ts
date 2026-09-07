import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VenuePoolCount } from '@ctb/collector';
import type { RunRepo, RunningRun } from '@ctb/engine';
import { checkFakeRows, checkMigrations, checkProcesses, dayAgo, digestLines, heartbeatAgeCell, type Check, type CompareRunInput, type DigestInput, type ProcessLine } from '@ctb/reports';
import type { TokenSpec } from '@ctb/universe';
import { escape, layout } from './html.js';
import { renderCompare } from './pages/compare.js';
import { renderHealth, type PaperRunRow } from './pages/health.js';
import { renderRunDetail, renderRunsList } from './pages/runs.js';
import { renderUniverse, UNIVERSE_SORTS } from './pages/universe.js';
import { RUN_MODES, RUN_STATUSES, type DashboardReads, type RunFilter } from './reads.js';

const VENDOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor');

export interface DashboardDeps {
  /** `PgDashboardReads` in production (see `commands/dashboard.ts`); a literal `{ listRuns: async
   *  () => [] }` in tests that don't exercise `/runs`. */
  reads: DashboardReads;
  /** `listRunning` (added alongside the health page's "paper runs" section) is `PgRunRepo`'s own
   *  method — the same one `status`'s paper-runs table already calls — so the two surfaces can never
   *  disagree about which runs are currently running. */
  runs: Pick<RunRepo, 'getRun' | 'listOrders' | 'listEquity' | 'listRunning'>;
  /** `perVenuePoolCounts`/`missingTicksApprox` are `PgSnapshotRepo`'s own methods (moved there,
   *  verbatim SQL, from `status`'s former inline queries) — added so the health page's three
   *  previously-missing sections (spec: per-venue pool table, missing-ticks line, paper runs) render
   *  the exact numbers `status --digest` prints, from the exact same calls. */
  collector: {
    digestInput(intervalSec: number, venues: string[], now: Date): Promise<DigestInput>;
    perVenuePoolCounts(): Promise<VenuePoolCount[]>;
    missingTicksApprox(intervalSec: number): Promise<string | null>;
  };
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
  /** Finding I3 (review round 1): every ticker the universe knows about, so the filter form's ticker
   *  options are never limited to whatever happens to be on the current (already-filtered) page — a
   *  pure in-memory list, no query, the same shape as `tickerOf`/`unitOf`. */
  tickers: () => string[];
  /** `/universe`'s row order and rank column: `loadUniverse().tokens`, a pure in-memory list (array
   *  position IS market-cap rank — spec's own verified fact), the same shape as `tickers`/`tickerOf`. */
  universeTokens: () => TokenSpec[];
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
/**
 * Builds the health page's "paper runs" rows the same way `status`'s own paper-runs table does
 * (`packages/cli/src/commands/status.ts`): `listRunning()` for the running set, one `getRun` per row
 * for its `params` (few rows at most — running paper processes, not request volume), and
 * `heartbeatAgeCell` (from `@ctb/reports`, the same function `status` calls) for liveness. Kept as a
 * standalone function so `oneRule.guard.test.ts`'s arithmetic scan has one small, obviously-correct
 * site to walk rather than this logic living inline inside `healthHandler`.
 */
async function paperRunRows(deps: DashboardDeps, running: RunningRun[], now: Date): Promise<PaperRunRow[]> {
  return Promise.all(running.map(async (r) => {
    const full = await deps.runs.getRun(r.id);
    return {
      id: r.id, strategy: r.strategyId, ticker: deps.tickerOf(r.baseUnit), rehearsal: r.rehearsal,
      heartbeatAge: heartbeatAgeCell(r.heartbeatAt, full?.params ?? {}, now),
      lastTick: r.lastTickTs ? r.lastTickTs.toISOString() : '-', created: r.createdAt.toISOString(),
    };
  }));
}

/** `/`: the digest as a status board, plus the doctor's process, migration and rehearsal-data checks,
 *  plus (spec: closing the runbook's admitted gap) the three sections `status --digest` also prints
 *  that this page did not yet carry: the per-venue pool table, the missing-ticks line, and the paper
 *  runs table — every one of them from the identical `PgSnapshotRepo`/`PgRunRepo` calls `status`
 *  itself makes, so the two surfaces can never legitimately disagree. */
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
  const perVenue = await deps.collector.perVenuePoolCounts();
  const missingTicks = await deps.collector.missingTicksApprox(deps.intervalSec);
  const running = await deps.runs.listRunning();
  const paperRuns = await paperRunRows(deps, running, now);
  return htmlPage(200, renderHealth({ digest, checks, now, perVenue, missingTicks, paperRuns }));
}

const PAGE_SIZE = 50;
/** Finding M1 (review round 1): `?page=1e21` passed `Number.isInteger` (1e21 has no fractional part)
 *  and `n < 1` (it's huge, not negative), so it reached `(query.page - 1) * PAGE_SIZE` as the SQL
 *  OFFSET parameter and Postgres rejected the out-of-range integer — a 500, not the 400 a bad query
 *  value is supposed to get everywhere else in this router. `Number.isSafeInteger` alone already
 *  rejects `1e21` (it is far past 2^53), and `MAX_PAGE` additionally names a sane ceiling explicitly
 *  rather than leaving "how big is too big" implicit in a bit-width nobody reading this would guess. */
const MAX_PAGE = 1_000_000;

/** Thrown only inside `parseRunsQuery` for a bad query value; caught in `runsHandler` and turned
 * into a 400 that names the accepted values (spec §6, "never a silent default"). */
class RunsQueryError extends Error {}

/**
 * Shared by `parseRunsQuery` (`mode`/`status`) and `parseUniverseSort` below — both need the identical
 * "unrecognised value gets a 400 naming what IS accepted" behaviour, just under a different route's own
 * error type so each handler's `catch` only ever swallows the error its OWN parser throws (never
 * accidentally catching a bug from an unrelated code path and turning it into a misleading 400). The
 * error constructor defaults to `RunsQueryError` so every existing `/runs` call site is unchanged.
 */
function parseEnumParam<T extends string>(
  raw: string | null, accepted: readonly T[], field: string, makeError: (message: string) => Error = (m) => new RunsQueryError(m),
): T | undefined {
  if (raw === null || raw === '') return undefined;
  if (!(accepted as readonly string[]).includes(raw)) {
    throw makeError(`${field} must be one of ${accepted.join(', ')}; got ${JSON.stringify(raw)}`);
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
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PAGE) {
      throw new RunsQueryError(`page must be an integer between 1 and ${MAX_PAGE}; got ${JSON.stringify(pageRaw)}`);
    }
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
  const body = renderRunsList({ runs, tickerOf: deps.tickerOf, tickers: deps.tickers(), filter: query.filter, page: query.page, pageSize: PAGE_SIZE, now: deps.now() });
  return htmlPage(200, body);
}

/**
 * `/runs/:id`: a non-integer id is a 400 (spec §6, "never a silent default"); a missing run is a
 * 404. Orders and equity are fetched in parallel — `listEquity` from the epoch so a resumed run's
 * earliest points (which can predate `runs.created_at` — see `report.ts`'s own comment on this) are
 * never silently dropped.
 *
 * IMPORTANT 3 (final review): `/runs/999999999999999999999` (23 digits) passed the `/^\d+$/` shape
 * check above — it IS all digits — but `Number('999999999999999999999')` is `1e+21`, a float far past
 * `Number.isSafeInteger`'s ~9e15 ceiling, and reached Postgres as a bigint parameter: `invalid input
 * syntax for type bigint: "1e+21"`, a 500 instead of the 400 every other bad parameter on this router
 * gets. The identical defect was already fixed for `?page=` above via `Number.isSafeInteger` plus an
 * explicit ceiling (`MAX_PAGE`); the run-id path never got the same treatment. A run id has no
 * business-meaningful ceiling the way a page number does (`MAX_PAGE` exists to name "how big is too
 * big" explicitly rather than leave it implicit in a bit width) — `Number.isSafeInteger` alone is
 * enough here, since every real run id is a small, sequentially-assigned integer.
 */
async function runDetailHandler(deps: DashboardDeps, idParam: string, path: string): Promise<HandlerResult> {
  if (!/^\d+$/.test(idParam)) return badRequest(path, `invalid run id ${JSON.stringify(idParam)}: must be a non-negative integer`);
  const id = Number(idParam);
  if (!Number.isSafeInteger(id)) return badRequest(path, `invalid run id ${JSON.stringify(idParam)}: too large to be a real run id`);
  const run = await deps.runs.getRun(id);
  if (!run) return notFound(path);
  const now = deps.now();
  const [orders, equity] = await Promise.all([deps.runs.listOrders(id), deps.runs.listEquity(id, new Date(0), now)]);
  const body = renderRunDetail({ run, ticker: deps.tickerOf(run.baseUnit), orders, equity, now });
  return htmlPage(200, body);
}

const MAX_COMPARE_IDS = 12;

/** Thrown only inside `parseCompareIds` for a bad query value; caught in `compareHandler` and turned
 * into a 400 that names the accepted values (spec §6, "never a silent default") — the same pattern
 * `RunsQueryError` follows for `/runs`. */
class CompareQueryError extends Error {}

/**
 * `/compare` accepts both `?ids=1,2,3` (one query occurrence, comma-joined — what an operator would
 * type by hand) and `?ids=1&ids=2` (what the checkbox form on `/runs` actually submits, one
 * `<input name="ids">` per ticked row) — `URLSearchParams.getAll('ids')` returns every OCCURRENCE of
 * the key in the order it appeared, so splitting each occurrence on `,` and flattening handles both
 * forms identically while preserving the order the operator selected, never sorting it. Every rule
 * below names itself in the 400 it throws, mirroring `report --compare`'s own `parseCompareList`.
 *
 * IMPORTANT 1 (final review): this used to accept a part as long as `Number(part)` was a finite
 * integer — `!Number.isInteger(n)` — the same shape defect `?page=` and `/runs/:id` were each fixed
 * for earlier in this file (see `MAX_PAGE`'s comment and `runDetailHandler`'s own IMPORTANT-3 comment).
 * Measured: `?ids=1e21` reached `deps.runs.getRun(1e21)` and Postgres rejected it with `invalid input
 * syntax for type bigint: "1e+21"` — a 500, not this router's usual 400 — and `?ids=0x10` silently
 * parsed as `Number('0x10') === 16` and rendered run 16, a bad parameter reinterpreted as a
 * DIFFERENT valid run without so much as a 400 to notice by. `+1`, `1.0` and `%201%20` (` 1 `) were
 * accepted the same way — `Number()` parses all of them fine, `Number.isInteger` doesn't care.
 * The fix is the same one already proven at `/runs/:id`: a strict `/^\d+$/` shape check (rejects a
 * sign, a decimal point, an exponent, a radix prefix, and any leading/trailing whitespace outright,
 * since none of those characters is a digit) BEFORE the numeric conversion, then `Number.isSafeInteger`
 * on top so a value that passes the shape check but is still too large to be a real run id
 * (`999999999999999999` — 18 digits, all of them digits) can't reach Postgres as a bigint either.
 */
function parseCompareIds(url: URL): number[] {
  const raw = url.searchParams.getAll('ids');
  const parts = raw.flatMap((v) => v.split(','));
  if (parts.length === 0) {
    throw new CompareQueryError('ids required: /compare?ids=1,2,3 or repeated ?ids=1&ids=2');
  }
  const ids: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!/^\d+$/.test(part) || !Number.isSafeInteger(n) || n <= 0) {
      throw new CompareQueryError(`ids must be positive integers; got ${JSON.stringify(part)}`);
    }
    ids.push(n);
  }
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup !== undefined) throw new CompareQueryError(`run ${dup} listed more than once in ids`);
  if (ids.length > MAX_COMPARE_IDS) {
    throw new CompareQueryError(`at most ${MAX_COMPARE_IDS} ids may be compared at once; got ${ids.length}`);
  }
  return ids;
}

/**
 * `/compare?ids=…` (spec §4.2): several runs' persisted headlines side by side, and a shared equity
 * chart. Ids are resolved SEQUENTIALLY, in the order given (never `Promise.all` across ids), so the
 * first missing id is always the one a 404 names, and the operator's own ordering is never disturbed
 * by whichever read happens to resolve first. For each id, orders and equity are fetched the same way
 * `runDetailHandler` fetches them for one run — `listEquity` from the epoch, regardless of mode, so a
 * backtest's empty equity array reaches `compareRunRows` exactly as `report --compare` reads it too.
 */
async function compareHandler(deps: DashboardDeps, url: URL, path: string): Promise<HandlerResult> {
  let ids: number[];
  try {
    ids = parseCompareIds(url);
  } catch (err) {
    if (err instanceof CompareQueryError) return badRequest(path, err.message);
    throw err;
  }
  const now = deps.now();
  const inputs: CompareRunInput[] = [];
  for (const id of ids) {
    const run = await deps.runs.getRun(id);
    // Named the same way `report --compare`'s own missing-run error does (`no run ${rid}`), so an
    // operator who copies an id between the CLI and this page sees the identical wording.
    if (!run) return errorPage(404, path, `no run ${id}`);
    const [orders, equity] = await Promise.all([deps.runs.listOrders(id), deps.runs.listEquity(id, new Date(0), now)]);
    inputs.push({ run, ticker: deps.tickerOf(run.baseUnit), equity, orders });
  }
  const body = renderCompare({ inputs, now });
  return htmlPage(200, body);
}

/** Thrown only inside `parseUniverseSort` for a bad `?sort=`; caught in `universeHandler` and turned
 * into a 400 that names the accepted values — the same shape `RunsQueryError`/`CompareQueryError`
 * follow for their own routes. */
class UniverseQueryError extends Error {}

function parseUniverseSort(url: URL): (typeof UNIVERSE_SORTS)[number] {
  return parseEnumParam(url.searchParams.get('sort'), UNIVERSE_SORTS, 'sort', (m) => new UniverseQueryError(m)) ?? 'rank';
}

/**
 * `/universe` (spec §4.2, M4c): the screener. This package's own code performs NO date arithmetic at
 * all — the "24 hours ago" target `snapshotsAt` needs comes from `@ctb/reports`'s `dayAgo(now)` (fix
 * round, IMPORTANT 2), the same package that already owns the other half of this figure
 * (`priceChangePct`), rather than from a `now.getTime() - 86_400_000` computed here and separately
 * allowlisted in `oneRule.guard.test.ts` — a widening that round closed instead of keeping. `withinMs`
 * is a plain numeric literal (26 hours), not a computed expression, so it needs no allowlist entry
 * either: wide enough that a single missed collector tick still finds ITS token's own nearest older
 * snapshot (`snapshotsAt`'s per-token degrade — see `reads.ts`), never nothing, on a collector that
 * ticks roughly hourly or faster.
 */
async function universeHandler(deps: DashboardDeps, url: URL, path: string): Promise<HandlerResult> {
  let sort: (typeof UNIVERSE_SORTS)[number];
  try {
    sort = parseUniverseSort(url);
  } catch (err) {
    if (err instanceof UniverseQueryError) return badRequest(path, err.message);
    throw err;
  }
  const now = deps.now();
  const withinMs = 93_600_000; // 26h
  const [latest, dayAgoSnapshots, coverage] = await Promise.all([
    deps.reads.latestSnapshotsPerToken(),
    deps.reads.snapshotsAt(dayAgo(now), withinMs),
    deps.reads.externalCoverageAll(),
  ]);
  const body = renderUniverse({ tokens: deps.universeTokens(), latest, dayAgo: dayAgoSnapshots, coverage, sort, now });
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
  if (path === '/compare') return compareHandler(deps, url, path);
  if (path === '/universe') return universeHandler(deps, url, path);
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
