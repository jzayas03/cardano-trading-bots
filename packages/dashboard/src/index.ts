/**
 * MINOR (final review): this barrel used to also re-export `RUN_MODES`/`RUN_STATUSES`/`DashboardReads`/
 * `RunFilter` (`reads.js`), `escape`/`layout`/`REHEARSAL_BANNER`/`statusWord`/`table`/`RenderedCell`
 * (`html.js`), `chartHtml`/`equitySeries`/`EquitySeries` (`chart.js`), and `renderRunDetail`/
 * `renderRunsList` (`pages/runs.js`) — the two M4a page renderers, with none of M4b/M4c's
 * (`renderCompare`, `renderUniverse`) ever added alongside them. The ONLY consumer of this package
 * across the whole repo is `packages/cli/src/commands/dashboard.ts`, and it only ever imports the four
 * names below (`grep -rn "@ctb/dashboard'" --include='*.ts' .` confirms this — every test in this
 * package imports its subject directly from `../src/...`, never through this barrel). Rather than add
 * two more page renderers to a list nothing outside this package reads, this barrel is trimmed to
 * exactly what has a real caller; if a future consumer needs a page renderer or an `html.js` helper
 * directly, add it back here as a reviewed, deliberate widening rather than carrying speculative surface.
 */
export { createDashboardServer, listen, type DashboardDeps } from './server.js';
export { PgDashboardReads } from './reads.js';
