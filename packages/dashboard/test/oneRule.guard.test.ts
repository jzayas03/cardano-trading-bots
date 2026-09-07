/**
 * The one rule (spec §4.1): `packages/dashboard` computes no number of its own. Every figure on
 * every page is the return value of a function imported from `@ctb/reports`.
 *
 * Round 1 of this guard keyed on four hardcoded identifier names plus two literal patterns and caught
 * only 1 of 6 realistic violations (see the task-5-fix-1 report for that table). It was replaced with
 * a SHAPE rule: any binary arithmetic operator (`+ - * / %`, including a compound-assignment form
 * like `+=`) sitting between two token-like operands, anywhere in the package outside `chart.ts`
 * (spec's one sanctioned lovelace-to-float conversion), is presumptively a local computation and
 * fails the test — regardless of what anything is named. A short, explicitly commented allowlist
 * covers the handful of genuine index/offset arithmetic sites that are not financial figures.
 *
 * Round 2 of this guard closes four holes a second review proved in that shape rule itself:
 *
 * (a) THE ALLOWLIST EXEMPTED A WHOLE LINE. `isAllowed` matched with `line.includes(needle)`, so once
 *     any allowlisted substring was found anywhere on a line, the ENTIRE line — including anything
 *     else appended to it — was skipped. A reviewer put a fresh violation on the SAME line as an
 *     already-allowlisted one (`const offset = (query.page - 1) * PAGE_SIZE; const returnPct = (end -
 *     start) / start * 100;`) and it passed clean. Fixed by making each allowlist entry the FULL
 *     trimmed line it names, matched by exact equality — not a substring — so appending anything to
 *     an allowlisted line changes what has to match and the line is scanned again.
 * (b) A LINE-WRAPPED OPERATOR WAS INVISIBLE. `const totalFees = feeA +` / `  feeB;` passed, because
 *     the old per-line scan needed a token after the operator on the SAME line — exactly what a
 *     formatter produces when an expression runs long, so this arrives by accident, not evasion.
 *     Fixed by joining a line that ends in a trailing binary operator with the line(s) that follow it
 *     before scanning (see `joinWrappedOperatorLines`).
 * (c) THE GUARD OVER-REPORTED ON ORDINARY MULTI-LINE SQL. Reformatting an existing query across lines
 *     failed the guard, because `SELECT *` reads as `token * token` once the surrounding backtick text
 *     is no longer recognisable as a string. The old preprocessing only stripped a backtick template
 *     that opened AND closed on the same physical line — a multi-line template's literal text reached
 *     the scanner untouched. The natural response (another allowlist entry) would only have widened
 *     hole (a) further, so this is fixed at the root instead: `stripNonCode` now tokenizes the WHOLE
 *     FILE (not line by line) with a small stack-based scanner, so comments, string literals, and
 *     template-literal TEXT are stripped — and a `${...}` expression's own code is kept and still
 *     scanned — regardless of how many lines they span. A `*` inside a SQL string, a `-` inside a CSS
 *     `calc()`, and a `+` inside a message are text, not arithmetic, wherever the enclosing literal
 *     happens to wrap.
 * (d) `chart.ts` WAS EXEMPTED AS A WHOLE FILE WITH NO GUARDRAIL ON WHAT LIVES THERE. The original
 *     defect (a hand-rolled percentage/ratio helper) could be driven straight back through it: define
 *     `export function pctOf(a, b) { return (a - b) / b * 100; }` in `chart.ts` and import it from a
 *     page — the arithmetic scan never looks at that file, so nothing caught it. The file exemption
 *     itself is correct (it is spec's one sanctioned lovelace-to-float conversion site) and stays, but
 *     a new test now pins `chart.ts`'s exported surface to EXACTLY `equitySeries` and `chartHtml`,
 *     so a new export there — the only way anything defined in that file could reach a page — fails
 *     the guard and forces a reviewed conversation about it.
 *
 * See the task-5-fix-2 report for the full injection-by-injection proof table (all six of round 1's
 * injections, plus one new injection per hole above, each proved red then reverted clean).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (extname(full) === '.ts') out.push(full);
  }
  return out;
}

const FILES = walk(SRC);

/**
 * Genuine index/offset/pagination arithmetic that is not a financial figure, and so is not something
 * `@ctb/reports` could sensibly own. Each entry's `line` is the FULL trimmed source line it names,
 * matched by exact equality (see hole (a) above) — narrow on purpose, so this list allows exactly the
 * reviewed line it names and nothing merely appended to or resembling it. Adding a new entry here is
 * itself a reviewable change.
 */
const ALLOWED_ARITHMETIC: ReadonlyArray<{ file: string; line: string; because: string }> = [
  { file: 'pages/health.ts', line: 'return [line.slice(0, idx), line.slice(idx + 2)];', because: 'string offset past a ": " separator, not a computed figure' },
  { file: 'pages/runs.ts', line: 'if (page > 1) links.push(`<a href="${escape(runsQueryString(filter, tickerOf, page - 1))}">&larr; prev</a>`);', because: 'M2 pager: the previous page number for the "prev" link, not a financial number' },
  { file: 'pages/runs.ts', line: 'if (rowsOnPage === pageSize) links.push(`<a href="${escape(runsQueryString(filter, tickerOf, page + 1))}">next &rarr;</a>`);', because: 'M2 pager: the next page number for the "next" link, not a financial number' },
  { file: 'pages/runs.ts', line: '<dt>resumes</dt><dd>${resumes.length}${resumes.length > 0 ? ` (last ${escape(resumes[resumes.length - 1])})` : \'\'}</dd>', because: 'array index into the resumes list, to show the last one' },
  { file: 'pages/runs.ts', line: 'const more = orders.length > ORDERS_MAX_ROWS ? `<p>&hellip; ${orders.length - ORDERS_MAX_ROWS} more orders</p>` : \'\';', because: 'count of rows past the display cap, for the "N more orders" line' },
  { file: 'server.ts', line: 'const offset = (query.page - 1) * PAGE_SIZE;', because: 'SQL OFFSET from a 1-based page number, not a financial number' },
];

/** Exact match against the FULL trimmed line — see hole (a) in the file header. A line that merely
 * CONTAINS an allowed expression, with anything else added to it, is not a match and gets scanned. */
function isAllowed(rel: string, rawLine: string): boolean {
  const trimmed = rawLine.trim();
  return ALLOWED_ARITHMETIC.some((a) => a.file === rel && a.line === trimmed);
}

/**
 * One stack frame of `stripNonCode`'s tokenizer. `code` covers both top-level file code and the code
 * inside a `${...}` template expression — the same rules apply in both places (a string, a nested
 * template, or a comment can open inside an expression exactly as it can anywhere else), so they share
 * one frame kind. `templateExprDepth` is only meaningful for a `code` frame that was pushed BECAUSE of
 * a `${`: it counts unmatched `{`/`}` seen since that point, so an object literal inside the expression
 * (`${ { x: 1 } }`) doesn't make the FIRST `}` look like the end of the expression.
 */
type Frame =
  | { kind: 'code'; templateExprDepth: number }
  | { kind: 'template' }
  | { kind: 'squote' }
  | { kind: 'dquote' }
  | { kind: 'lineComment' }
  | { kind: 'blockComment' };

function currentFrame(stack: readonly Frame[]): Frame {
  const frame = stack.at(-1);
  if (frame === undefined) throw new Error('stripNonCode: frame stack underflow — a bug in the tokenizer itself, not in the scanned source');
  return frame;
}

/**
 * Replaces every character that is not "real code" — line comments, block comments, single/double-
 * quoted string contents, and backtick template-literal TEXT (but never a `${...}` expression's own
 * code) — with a space, and leaves every newline exactly where it was. Because this runs once over the
 * WHOLE FILE with an explicit stack (not line by line, and not with one-shot regexes), a template
 * literal, block comment, or nested string/template INSIDE a `${...}` expression is stripped correctly
 * no matter how many lines it spans — this is the hole (c) fix: the previous version could only strip
 * a backtick that opened and closed on the same physical line, so a reformatted multi-line SQL
 * template's literal text (`SELECT *`, `runs -` as English, etc.) reached the arithmetic scan unstripped
 * and was flagged as a false positive.
 *
 * What this does NOT cover: a template literal or comment opening and closing entirely within one
 * `${...}` expression is handled (the `code` frame kind is shared), but there is no instance of that
 * in this small, hand-written package today, so it is exercised only incidentally, not by a dedicated
 * test — see "what this guard still does not cover" in the task-5-fix-2 report.
 */
function stripNonCode(text: string): string {
  const out: string[] = [];
  const stack: Frame[] = [{ kind: 'code', templateExprDepth: 0 }];

  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    const frame = currentFrame(stack);

    if (c === '\n') {
      out.push('\n');
      if (frame.kind === 'lineComment') stack.pop();
      continue;
    }

    switch (frame.kind) {
      case 'code':
        if (c === '/' && next === '/') { out.push(' ', ' '); i += 1; stack.push({ kind: 'lineComment' }); }
        else if (c === '/' && next === '*') { out.push(' ', ' '); i += 1; stack.push({ kind: 'blockComment' }); }
        else if (c === "'") { out.push(' '); stack.push({ kind: 'squote' }); }
        else if (c === '"') { out.push(' '); stack.push({ kind: 'dquote' }); }
        else if (c === '`') { out.push(' '); stack.push({ kind: 'template' }); }
        else if (c === '{') { frame.templateExprDepth += 1; out.push(c); }
        else if (c === '}' && frame.templateExprDepth > 0) { frame.templateExprDepth -= 1; out.push(c); }
        else if (c === '}' && stack.length > 1) { out.push(' '); stack.pop(); } // closes a `${...}` expression
        else out.push(c);
        break;

      case 'lineComment':
        out.push(' ');
        break;

      case 'blockComment':
        if (c === '*' && next === '/') { out.push(' ', ' '); i += 1; stack.pop(); }
        else out.push(' ');
        break;

      case 'squote':
      case 'dquote': {
        const quote = frame.kind === 'squote' ? "'" : '"';
        if (c === '\\') { out.push(' ', next === '\n' ? '\n' : ' '); i += 1; }
        else if (c === quote) { out.push(' '); stack.pop(); }
        else out.push(' ');
        break;
      }

      case 'template':
        if (c === '\\') { out.push(' ', next === '\n' ? '\n' : ' '); i += 1; }
        else if (c === '`') { out.push(' '); stack.pop(); }
        else if (c === '$' && next === '{') { out.push(' ', ' '); i += 1; stack.push({ kind: 'code', templateExprDepth: 0 }); }
        else out.push(' ');
        break;
    }
  }
  return out.join('');
}

// Requires whitespace around the operator with a token-like character immediately on each side, so a
// hyphenated CSS property (`max-width`, `border-collapse`, `--fg`) or SQL wildcard glued to its
// neighbours never matches — every real arithmetic expression in this codebase's own style puts spaces
// around its operators (see the six round-1 injections). A hand-formatted line that omitted those
// spaces (`a-b` instead of `a - b`) would still slip past this — a known residual gap, not fixed here
// (see the report).
const BINARY_ARITHMETIC = /([\w$)\]])\s+([-+*/%])\s+([\w$(])/;
// `total += x`-shaped local accumulation — no known instance in this package today, but the same
// mechanism as the `reduce((a, b) => a + b, ...)` injection above and just as capable of quietly
// summing fees or returns; cheap to close off before it exists.
const COMPOUND_ASSIGNMENT = /\w\s*[-+*/%]=/;
// A cleaned line that ends in "<token> <operator>" is a binary expression a formatter wrapped onto the
// next line (hole (b)) — the same style this codebase's real arithmetic already uses, just split.
const TRAILING_BINARY_OPERATOR = /[\w$)\]]\s+[-+*/%]$/;

/**
 * Builds the text actually scanned for line `i`: `cleanedLines[i]` on its own, UNLESS it ends in a
 * trailing binary operator (hole (b)), in which case the following line(s) are appended (space-
 * joined) until the trail stops — so `const totalFees = feeA +` / `  feeB;` is scanned as one unit,
 * exactly as if it had been written on a single line. `rawLabel` mirrors the same join over the RAW
 * (un-stripped) lines, purely for a readable failure message.
 */
function joinWrappedOperatorLines(rawLines: readonly string[], cleanedLines: readonly string[], startIndex: number): { scanned: string; rawLabel: string } {
  let scanned = cleanedLines[startIndex] ?? '';
  let rawLabel = (rawLines[startIndex] ?? '').trim();
  let j = startIndex;
  while (TRAILING_BINARY_OPERATOR.test(scanned.trimEnd()) && j + 1 < cleanedLines.length) {
    j += 1;
    scanned = `${scanned.trimEnd()} ${(cleanedLines[j] ?? '').trim()}`;
    rawLabel = `${rawLabel} ${(rawLines[j] ?? '').trim()}`;
  }
  return { scanned, rawLabel };
}

describe('@ctb/dashboard one-rule guard', () => {
  it('scans every .ts file under src (no file list is empty)', () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it('never contains binary arithmetic between two operands outside chart.ts and the reviewed allowlist', () => {
    for (const file of FILES) {
      const rel = relative(SRC, file);
      if (rel === 'chart.ts') continue; // the one sanctioned lovelace->float conversion, itself routed through adaStr — see the export-surface test below
      const rawText = readFileSync(file, 'utf8');
      const rawLines = rawText.split('\n');
      const cleanedLines = stripNonCode(rawText).split('\n');
      for (let i = 0; i < rawLines.length; i++) {
        if (isAllowed(rel, rawLines[i] ?? '')) continue;
        const { scanned, rawLabel } = joinWrappedOperatorLines(rawLines, cleanedLines, i);
        expect(BINARY_ARITHMETIC.test(scanned), `${rel}: local arithmetic: ${rawLabel}`).toBe(false);
        expect(COMPOUND_ASSIGNMENT.test(scanned), `${rel}: local compound-assignment arithmetic: ${rawLabel}`).toBe(false);
      }
    }
  });

  it('never divides a lovelace amount by 1_000_000/1e6, or multiplies by 100, outside chart.ts', () => {
    for (const file of FILES) {
      const rel = relative(SRC, file);
      if (rel === 'chart.ts') continue; // the one sanctioned lovelace->float conversion, itself routed through adaStr
      const rawText = readFileSync(file, 'utf8');
      const rawLines = rawText.split('\n');
      const cleanedLines = stripNonCode(rawText).split('\n');
      for (let i = 0; i < rawLines.length; i++) {
        if (isAllowed(rel, rawLines[i] ?? '')) continue;
        const scanned = cleanedLines[i] ?? '';
        expect(/\/\s*1_000_000\b|\/\s*1e6\b/i.test(scanned), `${rel}: hand lovelace->ADA division: ${(rawLines[i] ?? '').trim()}`).toBe(false);
        expect(/\*\s*100\b/.test(scanned), `${rel}: hand percent multiplication: ${(rawLines[i] ?? '').trim()}`).toBe(false);
      }
    }
  });

  it('never defines its own summarizer (the words "function summarize" or "Summarizer")', () => {
    for (const file of FILES) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      expect(text.includes('function summarize'), `${rel} defines its own summarize function`).toBe(false);
      expect(text.includes('Summarizer'), `${rel} references a local Summarizer (that name belongs to @ctb/engine's backtest loop, never this package)`).toBe(false);
    }
  });

  it('imports every sanctioned @ctb/reports function somewhere in the package', () => {
    const required = ['summarizeRun', 'adaStr', 'coverageLine', 'feedCountersLine', 'resumesOf', 'digestLines', 'checkDigestLines'];
    const imported = new Set<string>();
    const importRe = /import\s*\{([^}]+)\}\s*from\s*'@ctb\/reports'/g;
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(importRe)) {
        for (const spec of (m[1] ?? '').split(',')) {
          const name = spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
          if (name) imported.add(name);
        }
      }
    }
    for (const name of required) expect(imported.has(name), `@ctb/reports's ${name} is never imported anywhere in packages/dashboard/src`).toBe(true);
  });

  /**
   * Hole (d): `chart.ts` is exempt from the arithmetic scan above because it is spec's one sanctioned
   * lovelace-to-float conversion site — but that exemption previously came with no guardrail on what
   * ELSE could live in the file. The original defect (a hand-rolled ratio/percentage helper) could be
   * driven straight back through it: define `export function pctOf(a, b) { return (a - b) / b * 100;
   * }` in `chart.ts`, import it from a page, and the arithmetic scan never sees it. This pins the
   * file's exported surface to exactly the two exports the spec sanctions, so a new export there fails
   * loudly and forces a reviewed conversation instead of a silent pass-through.
   */
  it("chart.ts's exported surface stays pinned to exactly {equitySeries, chartHtml} — the one file this guard exempts from the arithmetic scan", () => {
    const chartFile = FILES.find((f) => relative(SRC, f) === 'chart.ts');
    if (chartFile === undefined) throw new Error('chart.ts not found under src — has it moved? the arithmetic-scan exemption above references it by this exact relative path');
    const text = readFileSync(chartFile, 'utf8');
    const exported = new Set<string>();
    // Matches a top-level `export function`/`export const` declaration's name. Deliberately does NOT
    // match `export interface`/`export type` — a type carries no runtime computation, so it is not
    // part of the surface this test is pinning.
    const exportRe = /^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/gm;
    for (const m of text.matchAll(exportRe)) {
      const name = m[1];
      if (name) exported.add(name);
    }
    expect(exported, "chart.ts exports something beyond {equitySeries, chartHtml} — a new export widens the file's exemption from the one-rule guard's arithmetic scan and needs its own review, not a silent pass-through").toEqual(new Set(['equitySeries', 'chartHtml']));
  });
});
