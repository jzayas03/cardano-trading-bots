/**
 * The one rule (spec §4.1): `packages/dashboard` computes no number of its own. Every figure on
 * every page is the return value of a function imported from `@ctb/reports`.
 *
 * Round 1 of this guard keyed on four hardcoded identifier names (`returnPct`, `maxDrawdownPct`,
 * `feesLovelace`, `feesAda`) plus two literal patterns (`/ 1_000_000`, `* 100`). A review proved it
 * caught only 1 of 6 realistic violations planted one at a time in `pages/runs.ts`:
 *
 *   const returnPct = (end - start) / start * 100;                    caught (name + shape both fired)
 *   const pct = Math.round(((endA - startA) / startA) * 10000) / 100; MISSED (no sensitive name)
 *   const totalFees = fees.reduce((a, b) => a + b, 0n);                MISSED (no sensitive name, no /)
 *   const ada = lov / 1_000_000n;                                      MISSED (bigint `n` suffix broke
 *                                                                       the `\b` after the digits)
 *   const elapsedSec = (d2.getTime() - d1.getTime()) / 1000;           MISSED (no sensitive name)
 *   const summarizeLocal = (xs) => xs.reduce((a, b) => a + b, 0);      MISSED (no sensitive name)
 *
 * The name-keyed rule is gone. What replaces it is a SHAPE rule: any binary arithmetic operator
 * (`+ - * / %`, including a compound-assignment form like `+=`) sitting between two token-like
 * operands, anywhere in the package outside `chart.ts` (spec's one sanctioned lovelace-to-float
 * conversion), is presumptively a local computation and fails the test — regardless of what anything
 * is named. A short, explicitly commented allowlist below covers the handful of genuine index/offset
 * arithmetic sites that are not financial figures (a string-slice offset, an array's last-index, a
 * "how many more rows" count, a pagination `OFFSET`); anything else has to earn its way onto that
 * list by being reviewed, not by picking an unlucky variable name.
 *
 * Source is scanned as text, not parsed, so two things are stripped before the operator scan so they
 * cannot produce false positives: single/double-quoted string literals (removed entirely — they can
 * never hold a `${}` expression) and comment lines (`//...`, or a line whose trimmed text starts with
 * `*`/`/**`/`/*`, since JSDoc prose routinely contains stray hyphens and slashes). Backtick template
 * literals are handled more carefully: a same-line template literal's plain HTML/SQL text (which can
 * itself contain a false-positive-looking `/` or `*`, e.g. `` `SELECT * FROM runs` `` or "run_equity +
 * paper_orders" as English prose) is discarded, but any `${...}` expression inside it is kept and
 * still scanned — an arithmetic expression hidden inside a rendered template fragment is exactly the
 * kind of thing this guard exists to catch, so nothing is allowed to make it invisible by nesting it
 * in a backtick string.
 *
 * Proved red against all six injections above (see the task-5-fix-1 report for the per-injection
 * table); restored.
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
 * `@ctb/reports` could sensibly own. Each entry is an exact substring of one specific line — narrow on
 * purpose, so this list allows exactly the reviewed expression it names and nothing that merely
 * resembles it. Adding a new entry here is itself a reviewable change.
 */
const ALLOWED_ARITHMETIC: ReadonlyArray<{ file: string; needle: string; because: string }> = [
  { file: 'pages/health.ts', needle: 'line.slice(idx + 2)', because: 'string offset past a ": " separator, not a computed figure' },
  { file: 'pages/runs.ts', needle: 'resumes.length - 1', because: 'array index into the resumes list, to show the last one' },
  { file: 'pages/runs.ts', needle: 'orders.length - ORDERS_MAX_ROWS', because: 'count of rows past the display cap, for the "N more orders" line' },
  { file: 'pages/runs.ts', needle: 'runsQueryString(filter, tickerOf, page - 1)', because: 'M2 pager: the previous page number for the "prev" link, not a financial number' },
  { file: 'pages/runs.ts', needle: 'runsQueryString(filter, tickerOf, page + 1)', because: 'M2 pager: the next page number for the "next" link, not a financial number' },
  { file: 'server.ts', needle: '(query.page - 1) * PAGE_SIZE', because: 'SQL OFFSET from a 1-based page number, not a financial number' },
];

function isAllowed(rel: string, line: string): boolean {
  return ALLOWED_ARITHMETIC.some((a) => a.file === rel && line.includes(a.needle));
}

/** Drops the line entirely if it is a comment (`//...`, or a line whose trimmed text starts with
 * `*`/`/**`/`/*`, since JSDoc prose routinely contains stray hyphens and slashes). */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**') || trimmed.startsWith('/*');
}

/**
 * For a same-line-closed backtick template literal, keeps only its `${...}` expression contents and
 * discards the literal text around them — so plain HTML/SQL text can never produce a false positive,
 * but an expression hidden inside a rendered fragment is never made invisible either. A backtick that
 * does not close on this line (the common case — every page is built from multi-line templates) is
 * left untouched: its plain-text lines elsewhere carry no closing/opening marker for this regex to
 * match, and its own expression lines are scanned normally like any other line.
 *
 * This MUST run before plain-quote stripping, not after: this package's backtick templates are full
 * of literal double quotes as ordinary HTML markup (`` `<a href="${...}">` ``, `` `<div id="${...}">` ``).
 * A naive quote-strip applied to the raw line first cannot tell that `"` apart from a real string
 * delimiter — it matches from the FIRST such `"` to the NEXT one and swallows everything between them,
 * including a `${...}` expression that happened to sit inside an `href`/`id`/`class` attribute (this
 * is exactly what hid the M2 pager link's `page - 1` from an earlier draft of this file).
 */
function stripBacktickText(line: string): string {
  return line.replace(/`(?:[^`\\]|\\.)*`/g, (whole) => {
    const exprs: string[] = [];
    const exprRe = /\$\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = exprRe.exec(whole))) exprs.push(m[1] ?? '');
    return exprs.join(' ');
  });
}

/** Strips single/double-quoted string literals (never able to hold a `${}` expression, so safe to
 * remove outright once any backtick template's HTML text is already gone — see `stripBacktickText`). */
function stripPlainStrings(line: string): string {
  return line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '');
}

function preprocess(line: string): string {
  if (isCommentLine(line)) return '';
  return stripPlainStrings(stripBacktickText(line));
}

// Requires whitespace around the operator with a token-like character immediately on each side, so a
// hyphenated CSS property (`max-width`, `border-collapse`, `--fg`) or SQL wildcard glued to its
// neighbours never matches — every real arithmetic expression in this codebase's own style puts spaces
// around its operators (see the six injections above), and every non-arithmetic hyphen/asterisk this
// package's HTML/CSS text actually contains does not.
const BINARY_ARITHMETIC = /([\w$)\]])\s+([-+*/%])\s+([\w$(])/;
// `total += x`-shaped local accumulation — no known instance in this package today, but the same
// mechanism as the `reduce((a, b) => a + b, ...)` injection above and just as capable of quietly
// summing fees or returns; cheap to close off before it exists.
const COMPOUND_ASSIGNMENT = /\w\s*[-+*/%]=/;

describe('@ctb/dashboard one-rule guard', () => {
  it('scans every .ts file under src (no file list is empty)', () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it('never contains binary arithmetic between two operands outside chart.ts and the reviewed allowlist', () => {
    for (const file of FILES) {
      const rel = relative(SRC, file);
      if (rel === 'chart.ts') continue; // the one sanctioned lovelace->float conversion, itself routed through adaStr
      const text = readFileSync(file, 'utf8');
      for (const rawLine of text.split('\n')) {
        if (isAllowed(rel, rawLine)) continue;
        const scanned = preprocess(rawLine);
        expect(BINARY_ARITHMETIC.test(scanned), `${rel}: local arithmetic: ${rawLine.trim()}`).toBe(false);
        expect(COMPOUND_ASSIGNMENT.test(scanned), `${rel}: local compound-assignment arithmetic: ${rawLine.trim()}`).toBe(false);
      }
    }
  });

  it('never divides a lovelace amount by 1_000_000/1e6, or multiplies by 100, outside chart.ts', () => {
    for (const file of FILES) {
      const rel = relative(SRC, file);
      if (rel === 'chart.ts') continue; // the one sanctioned lovelace->float conversion, itself routed through adaStr
      const text = readFileSync(file, 'utf8');
      for (const rawLine of text.split('\n')) {
        if (isAllowed(rel, rawLine)) continue;
        const scanned = preprocess(rawLine);
        expect(/\/\s*1_000_000\b|\/\s*1e6\b/i.test(scanned), `${rel}: hand lovelace->ADA division: ${rawLine.trim()}`).toBe(false);
        expect(/\*\s*100\b/.test(scanned), `${rel}: hand percent multiplication: ${rawLine.trim()}`).toBe(false);
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
});
