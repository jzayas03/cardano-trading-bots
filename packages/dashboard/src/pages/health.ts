/**
 * `/` — the morning digest as a status board (spec §4.2). Every figure here is a digest line already
 * computed by `digestLines` (the one rule, spec §4.1): this file only decides how to lay the lines
 * out and which two of them get a coloured `statusWord`, using `checkDigestLines` — the same function
 * `doctor` uses — so the page and `doctor`/`status --digest` can never disagree about what's OK, WATCH
 * or STOP. It never reads `process.env`.
 */
import { checkDigestLines, type Check, type Status } from '@ctb/reports';
import { escape, layout, statusWord } from '../html.js';

/** Splits a digest line on its first ": " into (label, rest). Every `digestLines` line uses exactly
 * this shape — "collector: ...", "ticks last 24h: ...", "venues LOST since the last discovery: ...",
 * etc. — so one split rule covers all of them; `00:00` inside "calls since 00:00 UTC" has no
 * following space, so it never matches ahead of the real separator. */
function splitLine(line: string): [string, string] {
  const idx = line.indexOf(': ');
  if (idx === -1) return [line, ''];
  return [line.slice(0, idx), line.slice(idx + 2)];
}

type Word = 'OK' | 'WARN' | 'FAIL' | 'STALE' | 'WATCH' | 'STOP' | 'LOST';

/** Prefers the specific word already sitting in the digest text (STALE/WATCH/STOP/LOST) over the
 * generic OK/WARN/FAIL from the check's status, so the badge says exactly what the line says. */
function wordFor(text: string, status: Status): Word {
  if (/\bSTOP\b/.test(text)) return 'STOP';
  if (/\bWATCH\b/.test(text)) return 'WATCH';
  if (/\bSTALE\b/.test(text)) return 'STALE';
  if (/\bLOST\b/.test(text)) return 'LOST';
  return status === 'ok' ? 'OK' : status === 'warn' ? 'WARN' : 'FAIL';
}

function statusToWord(status: Status): Word {
  return status === 'ok' ? 'OK' : status === 'warn' ? 'WARN' : 'FAIL';
}

export function renderHealth(input: { digest: string[]; checks: Check[]; now: Date }): string {
  const digestChecks = checkDigestLines(input.digest);
  const collectorCheck = digestChecks.find((c) => c.name === 'collector tick');
  const quotaCheck = digestChecks.find((c) => c.name === 'quota pace');

  const digestRows = input.digest
    .map((line) => {
      const [label, rest] = splitLine(line);
      let word = '';
      if (label === 'collector' && collectorCheck) word = statusWord(wordFor(rest, collectorCheck.status));
      else if (label === 'calls since 00:00 UTC' && quotaCheck) word = statusWord(wordFor(rest, quotaCheck.status));
      return `<tr><td>${escape(label)}</td><td>${escape(rest)}</td><td>${word}</td></tr>`;
    })
    .join('');

  const checkRows = input.checks
    .map((c) => `<tr><td>${escape(c.name)}</td><td>${statusWord(statusToWord(c.status))}</td><td>${escape(c.detail)}</td></tr>`)
    .join('');

  const body = `
<section>
<h2>Digest</h2>
<table><thead><tr><th>signal</th><th>detail</th><th>status</th></tr></thead><tbody>${digestRows}</tbody></table>
</section>
<section>
<h2>Checks</h2>
<table><thead><tr><th>check</th><th>status</th><th>detail</th></tr></thead><tbody>${checkRows}</tbody></table>
</section>
<p class="asof">as of ${escape(input.now.toISOString())}</p>`;

  return layout('Health', body, { refreshSec: 60 });
}
