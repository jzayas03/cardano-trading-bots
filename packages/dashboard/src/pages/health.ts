/**
 * `/` — the morning digest as a status board (spec §4.2). Every figure here is a digest line already
 * computed by `digestLines` (the one rule, spec §4.1): this file only decides how to lay the lines
 * out and which two of them get a coloured `statusWord`, using `checkDigestLines` — the same function
 * `doctor` uses — so the page and `doctor`/`status --digest` can never disagree about what's OK, WATCH
 * or STOP. It never reads `process.env`.
 *
 * Three sections below the original digest/checks board carry `status --digest`'s three trailing
 * sections the runbook used to admit this page dropped: the per-venue pool table, the missing-ticks
 * line, and the paper-runs table. Every value in them arrives from `server.ts`'s `healthHandler`
 * already computed — `PgSnapshotRepo.perVenuePoolCounts`/`missingTicksApprox` (moved verbatim off
 * `status`'s own former inline queries) and `heartbeatAgeCell` (`@ctb/reports`, the same function
 * `status` calls) — so this file, as before, does no arithmetic of its own; it only lays rows out.
 */
import { checkDigestLines, type Check, type Status } from '@ctb/reports';
import { escape, layout, statusWord, table, type RenderedCell } from '../html.js';

/** One row of the "paper runs" table, already fully computed by `server.ts`'s `paperRunRows` (id,
 *  strategy, ticker, rehearsal flag, heartbeat age, last tick, created — the same seven fields
 *  `status`'s own paper-runs table prints). */
export interface PaperRunRow {
  id: number;
  strategy: string;
  ticker: string;
  rehearsal: boolean;
  heartbeatAge: string;
  lastTick: string;
  created: string;
}

/** Splits a digest line on its first ": " into (label, rest). Every `digestLines` line uses exactly
 * this shape — "collector: ...", "ticks last 24h: ...", "venues LOST since the last discovery: ...",
 * etc. — so one split rule covers all of them; `00:00` inside "calls since 00:00 UTC" has no
 * following space, so it never matches ahead of the real separator. */
function splitLine(line: string): [string, string] {
  const idx = line.indexOf(': ');
  if (idx === -1) return [line, ''];
  return [line.slice(0, idx), line.slice(idx + 2)];
}

/**
 * `Check.status` is the ONLY input to a badge — never the digest line's own text. A prior version had
 * a `wordFor()` that regexed the digest text for STOP/WATCH/STALE/LOST and fell back to `status` only
 * when none of those words appeared there: two reporters for one decision, agreeing today by luck and
 * bound to disagree the moment a line contains one of those words for an unrelated reason, at which
 * point the board would contradict `doctor`/`status --digest`. The finer STOP/WATCH/STALE/LOST wording
 * is not lost — it already sits in the digest line's own text, printed verbatim in the adjacent detail
 * cell right next to this badge.
 */
function statusToWord(status: Status): 'OK' | 'WARN' | 'FAIL' {
  return status === 'ok' ? 'OK' : status === 'warn' ? 'WARN' : 'FAIL';
}

export function renderHealth(input: {
  digest: string[];
  checks: Check[];
  now: Date;
  perVenue: Array<{ dex: string; pools: number; tickTs: Date }>;
  missingTicks: string | null;
  paperRuns: PaperRunRow[];
}): string {
  const digestChecks = checkDigestLines(input.digest);
  const collectorCheck = digestChecks.find((c) => c.name === 'collector tick');
  const quotaCheck = digestChecks.find((c) => c.name === 'quota pace');

  const digestRows: Array<Array<string | RenderedCell>> = input.digest.map((line) => {
    const [label, rest] = splitLine(line);
    if (label === 'collector' && collectorCheck) return [label, rest, statusWord(statusToWord(collectorCheck.status))];
    if (label === 'calls since 00:00 UTC' && quotaCheck) return [label, rest, statusWord(statusToWord(quotaCheck.status))];
    return [label, rest, ''];
  });

  const checkRows: Array<Array<string | RenderedCell>> = input.checks.map((c) => [c.name, statusWord(statusToWord(c.status)), c.detail]);

  const perVenueRows: Array<Array<string | number>> = input.perVenue.map((v) => [v.dex, v.pools, v.tickTs.toISOString()]);

  // Same shape `status`'s own paper-runs table uses: a table when something is running, the literal
  // text `status` prints (`(none running)`) when nothing is — never `table()`'s generic empty-state
  // message, which would read as "no data" rather than "confirmed nothing running" (spec: an empty
  // table here would read as a page that failed to load).
  const paperRunsSection = input.paperRuns.length
    ? table(
        ['id', 'strategy', 'ticker', 'rehearsal', 'heartbeat age (s)', 'last tick', 'created'],
        input.paperRuns.map((r) => [r.id, r.strategy, r.ticker, String(r.rehearsal), r.heartbeatAge, r.lastTick, r.created]),
      )
    : '<p class="empty">(none running)</p>';

  const body = `
<section>
<h2>Digest</h2>
${table(['signal', 'detail', 'status'], digestRows)}
</section>
<section>
<h2>Checks</h2>
${table(['check', 'status', 'detail'], checkRows)}
</section>
<section>
<h2>Per-venue pools (latest tick)</h2>
${table(['dex', 'pools', 'tick'], perVenueRows)}
</section>
<section>
<h2>Collector coverage</h2>
<p>ticks missing in last 24h (approx): ${escape(input.missingTicks ?? 'n/a')}</p>
</section>
<section>
<h2>Paper runs</h2>
${paperRunsSection}
</section>
<p class="asof">as of ${escape(input.now.toISOString())}</p>`;

  return layout('Health', body, { refreshSec: 60 });
}
