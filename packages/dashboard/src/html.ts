/**
 * Every dashboard page is built from these five helpers. `escape` is the one function every
 * interpolated value must pass through before it reaches a template string: a run's `stop_reason`,
 * a strategy id, a rejection reason and a token ticker all reach the page from the database, and an
 * unescaped `<` in any of them silently corrupts the table it sits in (not an attack scenario here,
 * a correctness one). `table()` bakes that in so a page can't forget it.
 */

/** Escapes the five HTML-significant characters; null/undefined render as the empty string, never `"null"`. */
export function escape(s: string | number | bigint | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const REHEARSAL_BANNER = 'REHEARSAL — synthetic data — not evidence';

/**
 * A pre-rendered HTML fragment, branded so `table()` can tell it apart from a plain cell value and
 * pass it through untouched instead of escaping it (escaping it a second time would corrupt it, and
 * `table()` has no other way to know a cell is already safe HTML). The only way to get one from
 * outside this module is a function that already controls and escapes its own output — `statusWord()`
 * below — never build one by hand from unescaped external data.
 */
export interface RenderedCell {
  readonly html: string;
}

function isRenderedCell(c: unknown): c is RenderedCell {
  return typeof c === 'object' && c !== null && 'html' in c && typeof (c as RenderedCell).html === 'string';
}

/** The word IS the signal (spec §3, CLAUDE.md UI guardrail); colour is a secondary cue only, never the only one. */
export function statusWord(word: 'OK' | 'WARN' | 'FAIL' | 'STALE' | 'WATCH' | 'STOP' | 'LOST'): RenderedCell {
  return { html: `<span class="status status-${word.toLowerCase()}">${word}</span>` };
}

const PAGE_CSS = `
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafafa; --muted: #666; --border: #ddd;
  --ok: #1a7f37; --warn: #9a6700; --fail: #cf222e; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e6e6; --bg: #1a1a1a; --muted: #999; --border: #3a3a3a; } }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 1.5rem; }
h1 { font-size: 1.25rem; margin: 0 0 1rem; }
h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; color: var(--muted); }
table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
th { color: var(--muted); font-weight: 600; }
p.empty { color: var(--muted); font-style: italic; }
p.asof { color: var(--muted); font-size: 0.8rem; }
.status-ok { color: var(--ok); }
.status-warn, .status-watch { color: var(--warn); }
.status-fail, .status-stop, .status-stale, .status-lost { color: var(--fail); }
.status { font-weight: 600; }
.banner.rehearsal { background: var(--warn); color: #1a1a1a; padding: 0.5rem 0.75rem; font-weight: 600; margin-bottom: 1rem; }
nav.sitenav { margin-bottom: 1rem; font-size: 0.9rem; }
nav.sitenav a { color: var(--fg); margin-right: 1rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dt { color: var(--muted); }
dd { margin: 0; }
`;

/**
 * IMPORTANT 5 (final review): `/` links to nothing, `/runs/:id` links nowhere, `/universe` is
 * reachable only by typing the path, and an error page carried zero links — browser-back was the only
 * way out of any page, and there was no path from `/` to `/runs` at all despite the spec's own morning
 * workflow assuming the operator opens the dashboard and clicks into a run. Three plain links, present
 * on EVERY page `layout()` renders (health board, runs list, run detail, compare, universe, and every
 * error page — `errorPage`/`notFound`/`badRequest`/`internalErrorPage` in `server.ts` all go through
 * this same function), so there is always a way home. Plain `<a href>` tags, no JavaScript, per spec's
 * own constraint.
 */
const SITE_NAV = '<nav class="sitenav"><a href="/">Health</a><a href="/runs">Runs</a><a href="/universe">Universe</a></nav>';

/**
 * Full document. The rehearsal banner (when present) renders before the title, so it is the first
 * thing on the page regardless of what the caller passes as `body`.
 *
 * IMPORTANT 2 (final review): `chart.ts`'s `chartHtml` emits a bare inline `new uPlot(...)`, and this
 * function emitted uPlot's STYLESHEET but never its SCRIPT — so a page with a chart threw
 * `ReferenceError: uPlot is not defined` in a real browser and rendered an empty box, while both task
 * reports that shipped this asserted only that the page body *contains* `new uPlot(`, which was true
 * and proved nothing about whether the library that call needs was ever loaded. `opts.chart: true`
 * loads BOTH the stylesheet and the 51 KB script — in `<head>`, with no `defer`/`async`, so the browser
 * finishes parsing and running it before it reaches this function's own `body` interpolation below,
 * where a chart page's inline `new uPlot(...)` script sits. Only a page that actually instantiates a
 * chart passes `chart: true` (currently: the run detail page, and only when it has enough persisted
 * equity points — see `pages/runs.ts`'s `renderEquityChart`) so the health board and the runs list
 * never pay for 51 KB they do not use.
 *
 * `opts.rehearsalText` (final review, MINOR): overrides the banner's own wording without touching
 * whether it shows at all (`opts.rehearsal` still decides that). `/compare` is the only caller that
 * passes it today — see `pages/compare.ts`'s own comment for why a mixed comparison needs different
 * wording than a single run's page.
 */
export function layout(title: string, body: string, opts: { refreshSec?: number; rehearsal?: boolean; rehearsalText?: string; chart?: boolean } = {}): string {
  // `opts.refreshSec` is typed as `number`, so this is not reachable today — but every interpolation
  // in this file goes through `escape()` on principle (Task 5's guard test pins that literally), so a
  // future loosening of the type (or a caller reaching in with `as`) can't reintroduce an unescaped hole.
  const refreshMeta = opts.refreshSec !== undefined ? `<meta http-equiv="refresh" content="${escape(opts.refreshSec)}">` : '';
  const banner = opts.rehearsal ? `<div class="banner rehearsal">${escape(opts.rehearsalText ?? REHEARSAL_BANNER)}</div>` : '';
  const chartAssets = opts.chart
    ? '<link rel="stylesheet" href="/vendor/uPlot.min.css">\n<script src="/vendor/uPlot.iife.min.js"></script>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshMeta}
<title>${escape(title)}</title>
${chartAssets}
<style>${PAGE_CSS}</style>
</head>
<body>
${banner}
${SITE_NAV}
<h1>${escape(title)}</h1>
${body}
</body>
</html>
`;
}

/**
 * Every plain cell is escaped; a `RenderedCell` (from `statusWord()`) passes through untouched instead
 * — this is the type-level fix for the "no page actually uses `table()`" finding: before, `table()`'s
 * cell type could never carry a pre-rendered `<span>`, so every real page hand-rolled its own
 * `<table>` markup and the "escaping rides on the type system" property was true of nothing. An empty
 * `rows` renders `<p class="empty">none</p>` instead of a headers-only table.
 *
 * `columns` accepts a `RenderedCell` per header too (final review, IMPORTANT 5's "while you are there"
 * note): `/universe`'s sortable column headers link to their own `?sort=` value, so an operator doesn't
 * have to hand-edit the URL to sort by depth or 24h change — a plain string header still renders as
 * plain escaped text exactly as before, so every existing caller is unaffected.
 */
export function table(columns: Array<string | RenderedCell>, rows: Array<Array<string | number | bigint | null | undefined | RenderedCell>>): string {
  if (rows.length === 0) return '<p class="empty">none</p>';
  const thead = `<thead><tr>${columns.map((c) => `<th>${isRenderedCell(c) ? c.html : escape(c)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((cell) => `<td>${isRenderedCell(cell) ? cell.html : escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}
