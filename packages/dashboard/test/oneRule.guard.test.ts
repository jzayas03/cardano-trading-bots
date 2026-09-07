/**
 * The one rule (spec §4.1): `packages/dashboard` computes no number of its own. Every figure on
 * every page is the return value of a function imported from `@ctb/reports`.
 *
 * The brief's proposed regex (a negative lookahead requiring one of the sanctioned function names to
 * appear later on the SAME line as a `returnPct|maxDrawdownPct|feesLovelace|feesAda` assignment)
 * turned out to flag correct code: a plain read like `returnPct: s.returnPct ?? '-'` never mentions
 * `summarizeRun` on that line (the call already happened earlier, to produce `s`), so the lookahead
 * fired on the very pattern the whole rest of this file uses. The rule actually enforced here is
 * more direct and, empirically, exactly as strict where it matters: a bare member read or a function
 * call never contains an arithmetic operator (`+ - * /`) between two operands, and a hand-rolled
 * recomputation always does — `(end - start) / start * 100` has three; `s.returnPct` and
 * `adaStr(s.feesLovelace)` have none. String literals are stripped before this check so a value like
 * `'-'` (a literal dash, not subtraction) can't cause a false positive.
 *
 * Proved red on 2026-09-07 by adding `const returnPct = (end - start) / start * 100;` to
 * `pages/runs.ts` — see the task report for the exact diff and failure output — then restoring it.
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

/** Strips single/double/backtick string literals so a literal `'-'` or `'/'` in display text never
 * reads as an arithmetic operator. Not a full JS parser (a literal containing an escaped quote of a
 * different kind can confuse it) — good enough for the vocabulary this codebase's source actually uses. */
function withoutStringLiterals(line: string): string {
  return line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '');
}

const SENSITIVE_ASSIGNMENT = /(returnPct|maxDrawdownPct|feesLovelace|feesAda)\s*[:=]\s*([^;,\n]+)/g;
const ARITHMETIC_OPERATOR = /[-+*/]/;
const LOVELACE_DIVISION = /\/\s*1_000_000\b|\/\s*1e6\b/i;
const PERCENT_MULTIPLY = /\*\s*100\b/;

describe('@ctb/dashboard one-rule guard', () => {
  it('scans every .ts file under src (no file list is empty)', () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it('never assigns returnPct/maxDrawdownPct/feesLovelace/feesAda from a local arithmetic expression', () => {
    for (const file of FILES) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        const stripped = withoutStringLiterals(line);
        for (const m of stripped.matchAll(SENSITIVE_ASSIGNMENT)) {
          const rhs = m[2] ?? '';
          expect(ARITHMETIC_OPERATOR.test(rhs), `${rel}: local arithmetic on ${m[1]}: ${line.trim()}`).toBe(false);
        }
      }
    }
  });

  it('never divides a lovelace amount by 1_000_000/1e6, or multiplies by 100, outside chart.ts', () => {
    for (const file of FILES) {
      const rel = relative(SRC, file);
      if (rel === 'chart.ts') continue; // the one sanctioned lovelace->float conversion, itself routed through adaStr
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        const stripped = withoutStringLiterals(line);
        expect(LOVELACE_DIVISION.test(stripped), `${rel}: hand lovelace->ADA division: ${line.trim()}`).toBe(false);
        expect(PERCENT_MULTIPLY.test(stripped), `${rel}: hand percent multiplication: ${line.trim()}`).toBe(false);
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
