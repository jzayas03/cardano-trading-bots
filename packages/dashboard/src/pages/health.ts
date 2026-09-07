/**
 * `/` — the morning digest as a status board (spec §4.2). Every figure here is a digest line already
 * computed by `digestLines` (the one rule, spec §4.1): this file only decides how to lay the lines
 * out and which two of them get a coloured `statusWord`, using `checkDigestLines` — the same function
 * `doctor` uses — so the page and `doctor`/`status --digest` can never disagree about what's OK, WATCH
 * or STOP. It never reads `process.env`.
 */
import { checkDigestLines, type Check, type Status } from '@ctb/reports';
import { escape, layout, statusWord, table, type RenderedCell } from '../html.js';

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

export function renderHealth(input: { digest: string[]; checks: Check[]; now: Date }): string {
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

  const body = `
<section>
<h2>Digest</h2>
${table(['signal', 'detail', 'status'], digestRows)}
</section>
<section>
<h2>Checks</h2>
${table(['check', 'status', 'detail'], checkRows)}
</section>
<p class="asof">as of ${escape(input.now.toISOString())}</p>`;

  return layout('Health', body, { refreshSec: 60 });
}
