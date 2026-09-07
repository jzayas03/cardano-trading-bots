/**
 * The one rule (spec §4.1): `packages/dashboard` computes no number of its own. Every figure on
 * every page is the return value of a function imported from `@ctb/reports`.
 *
 * Round 1 of this guard keyed on four hardcoded identifier names plus two literal patterns and caught
 * only 1 of 6 realistic violations (see the task-5-fix-1 report for that table). It was replaced with
 * a SHAPE rule over source TEXT: any binary arithmetic operator sitting between two token-like
 * operands, anywhere in the package outside `chart.ts`, is presumptively a local computation and
 * fails the test — regardless of what anything is named.
 *
 * Round 2 closed four holes in that text-based shape rule (whole-line allowlist matches, an invisible
 * line-wrapped operator, false positives on reformatted multi-line SQL, and an unguarded `chart.ts`
 * export surface) — see that round's report for the details.
 *
 * Round 3 (this round) replaces the SCANNING MECHANISM entirely. A regex/tokenizer over source text
 * can only ever approximate "is this arithmetic" — round 2's own report honestly disclosed two
 * remaining bypasses:
 *   - UNSPACED OPERATORS: `const returnPct=(end-start)/start*100;` passed clean, because
 *     `BINARY_ARITHMETIC` required whitespace around the operator (deliberately, to avoid matching a
 *     hyphenated CSS property or a SQL wildcard glued to its neighbour — see round 2's own comment on
 *     that regex). This is not an evasion; it is simply how some people format code, and the repo's
 *     ESLint config has no spacing rule to stop it.
 *   - EXPONENTIATION: `a ** b` never matched any of the single-character operator classes.
 * Patching the regex again would only buy the next bypass. So this round throws the whole text-based
 * approach away and parses each file with the TypeScript compiler API (`ts.createSourceFile`,
 * already a devDependency of the repo) instead of pattern-matching its characters.
 *
 * WHY THIS REMOVES THE BUG CLASS, NOT JUST THE TWO KNOWN INSTANCES: a parser already knows, natively,
 * which characters are code and which are a comment, a string, or template-literal text — that is its
 * job. Every one of round 1 and round 2's bypasses (comments, string/template contents, spacing,
 * line-wrapping, multi-line template reformatting, and now exponentiation) was a symptom of the same
 * root cause: a regex or hand-rolled tokenizer trying to reconstruct that knowledge from characters.
 * Walking the real AST for `BinaryExpression` nodes makes an entire FAMILY of future bypasses
 * impossible by construction, not just the two this round happens to name:
 *   - Spacing is irrelevant — the parser doesn't care whether `a-b` or `a - b` was written.
 *   - `**` is just another `BinaryExpression` operator token, no special-casing needed.
 *   - A comment, string, or template literal's TEXT is never an expression node in the first place —
 *     there is nothing to "strip" (round 2's entire `stripNonCode` tokenizer, ~70 lines, is deleted;
 *     see git history for that machinery if it's ever needed as a reference).
 *   - A wrapped multi-line expression is one AST node regardless of how many lines the formatter split
 *     it across — no more `joinWrappedOperatorLines` special case.
 *   - The scan naturally recurses into every nesting depth (arrow function bodies, call arguments,
 *     ternaries, template-literal `${...}` holes) via `ts.forEachChild`, the same way the parser itself
 *     does, so there's no separate "did we remember to look inside a callback" question.
 *
 * THE RULE, IN PLAIN LANGUAGE: walk every `.ts` file under `packages/dashboard/src` (except
 * `chart.ts`, spec's one sanctioned lovelace-to-float conversion site) and look at every binary
 * arithmetic expression (`+ - * / % **`, and their compound-assignment forms `+= -= *= /= %= **=`).
 * If BOTH sides are numeric constants (e.g. `2 * 3`), it's a literal computation, not a computed
 * figure — allowed. Otherwise it's presumptively a local computation and fails the test, unless the
 * exact expression text is on the short, commented allowlist below (genuine index/pagination
 * arithmetic, reviewed one entry at a time).
 *
 * WHAT THIS STILL DOES NOT COVER (read before assuming the gap list is empty):
 *   - `++` / `--` (pre/post increment and decrement) are not `BinaryExpression` nodes in the TS AST,
 *     so a hand-rolled running total built with `total++` would not be caught by this scan. No
 *     instance exists in this package today; if one is ever added, it needs its own check (a
 *     `PrefixUnaryExpression`/`PostfixUnaryExpression` walk keyed on `++`/`--`), which this guard does
 *     not currently do.
 *   - Bitwise operators (`&`, `|`, `^`, `<<`, `>>`, `>>>`) are not treated as arithmetic here, matching
 *     both prior rounds — spec §4.1's concern is financial figures, and nothing in this package has a
 *     legitimate reason to bit-shift a lovelace amount, so this is an intentional non-goal, not an
 *     oversight.
 *   - This scan does not use the type checker (no `ts.Program`, just a standalone
 *     `ts.createSourceFile` per file) — it does not know or care whether an operand is a `number`, a
 *     `bigint`, or a `string`. That is deliberate, not a gap: string concatenation with `+` on two
 *     string-typed operands is now VISIBLE to this scan where the old regex might have missed it
 *     (a bare `+` with no spacing rule around it was exactly round 2's blind spot). Rather than widen
 *     the guard to special-case strings via the type checker, the fix belongs in the page code — use a
 *     template literal instead of `+` for string-building. As of this round, `packages/dashboard/src`
 *     has no `+`-based string concatenation left to fix (checked: every string built in this package
 *     already uses a template literal), so no page-code change was needed to satisfy this.
 *   - Round 2's separate assertion ("never divides a lovelace amount by 1_000_000/1e6, or multiplies
 *     by 100") is REMOVED, not silently — it is a strict subset of the general rule above. That
 *     assertion existed because the old text-based scan required whitespace around an operator and so
 *     could miss `x/1_000_000n` if unspaced; the AST walk above has no such blind spot: ANY
 *     `identifier / 1_000_000n`-shaped expression is already caught by the general "not both operands
 *     numeric constants" rule, with no separate check needed. Keeping a redundant assertion around
 *     would only add a second thing to update every time the general rule changes, for zero added
 *     coverage.
 *   - Arithmetic expressed as a CALL has no `BinaryExpression` node at all and is invisible to this
 *     scan: `Math.pow(a, b)` computes the same figure `a ** b` would, but is a `CallExpression`, not a
 *     binary operator, so nothing here inspects its arguments for "is this a financial figure".
 *   - Unary negation of an already-computed figure is not caught either — `const netLoss = -pnl;` is a
 *     `PrefixUnaryExpression` with operator `-` and a single operand, never a `BinaryExpression`, so it
 *     falls outside this walk entirely. This is the same family as the already-noted `++`/`--` gap: a
 *     unary AST shape this scan does not look at, not a binary one it looks at and misjudges.
 *   - A helper defined in a SIBLING package (e.g. a new function added to `@ctb/engine` or a brand-new
 *     workspace package) and imported into `packages/dashboard/src` would defeat spec §4.1's actual
 *     invariant — the dashboard would still be "computing" a figure, just one line removed — while
 *     sitting entirely outside this guard's subject (`walk(SRC)` only ever lists files under
 *     `packages/dashboard/src`). This guard has no way to see across a package boundary; that would
 *     need its own guard (or a `@ctb/reports`-only allowlist enforced at the import level) and is not
 *     attempted here.
 *
 * See the task-5-fix-3 report for the thirteen-probe injection table (all eleven of round 1 and 2's
 * injections re-proved red under the new mechanism, plus the two round-3-specific bypasses, plus two
 * over-report checks that must NOT fire), each proved red (or confirmed clean) then reverted
 * byte-exact.
 *
 * Round 4 (this round) closed two remaining one-line bypasses, both mechanisms this file added in
 * earlier rounds rather than the arithmetic walk itself: the `chart.ts` export-surface pin (a regex
 * over source text, evaded by `export class`/`export let`/`export default`/`export { name }` — see
 * that test's own comment below for the four-way table) is now an AST walk of the same
 * `ts.SourceFile`; and `ALLOWED_ARITHMETIC` entries now pin an exact occurrence `count`, closing the
 * hole where a brand-new computed figure that happened to reuse an already-allowlisted expression's
 * TEXT passed silently (see that constant's own comment above). See the task-5-fix-4 report for both
 * injection tables.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';
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
 * `@ctb/reports` could sensibly own. `expr` is the EXACT text of the offending `BinaryExpression` node
 * (via `node.getText(sourceFile)`) — narrower than round 2's whole-line match, since the AST gives us
 * the precise sub-expression rather than the line it happens to sit on. Two entries can share a file
 * and still both be needed for a single source line: `server.ts`'s
 * `const offset = (query.page - 1) * PAGE_SIZE;` contains TWO arithmetic `BinaryExpression` nodes (the
 * inner `query.page - 1` and the outer `(query.page - 1) * PAGE_SIZE`), and the walk below visits and
 * checks both independently. Adding a new entry here is itself a reviewable change.
 *
 * `count` pins how many times THIS exact (file, expr) pair is expected to appear in `src` today (every
 * entry below is 1). Without it, the allowlist exempted an expression's TEXT everywhere it appears in
 * its file, not the one reviewed call site: a SECOND, brand-new `orders.length - ORDERS_MAX_ROWS`
 * added anywhere in `pages/runs.ts` (plausible drift, e.g. `const trimmedFees = orders.length -
 * ORDERS_MAX_ROWS;`) reused the same text as the reviewed "N more orders" line and passed clean,
 * because `isAllowed` only ever checked membership, never cardinality. The count check below (in the
 * `it` that walks `FILES`) tallies every occurrence this scan actually allows through and asserts the
 * total for each entry equals `count` exactly — a second occurrence of the same text makes the tally 2
 * against an expected 1, which fails and forces a human to add a distinct, separately-reviewed entry
 * (or, for the rare legitimate case of the same figure needed twice, to bump `count` by hand after
 * confirming the new site).
 */
const ALLOWED_ARITHMETIC: ReadonlyArray<{ file: string; expr: string; because: string; count: number }> = [
  { file: 'pages/health.ts', expr: 'idx + 2', because: 'string offset past a ": " separator, not a computed figure', count: 1 },
  { file: 'pages/runs.ts', expr: 'page - 1', because: 'M2 pager: the previous page number for the "prev" link, not a financial number', count: 1 },
  { file: 'pages/runs.ts', expr: 'page + 1', because: 'M2 pager: the next page number for the "next" link, not a financial number', count: 1 },
  { file: 'pages/runs.ts', expr: 'resumes.length - 1', because: 'array index into the resumes list, to show the last one', count: 1 },
  { file: 'pages/runs.ts', expr: 'orders.length - ORDERS_MAX_ROWS', because: 'count of rows past the display cap, for the "N more orders" line', count: 1 },
  { file: 'server.ts', expr: 'query.page - 1', because: 'SQL OFFSET from a 1-based page number, not a financial number (the inner term of the next entry)', count: 1 },
  { file: 'server.ts', expr: '(query.page - 1) * PAGE_SIZE', because: 'SQL OFFSET from a 1-based page number, not a financial number', count: 1 },
];

function isAllowed(rel: string, exprText: string): boolean {
  return ALLOWED_ARITHMETIC.some((a) => a.file === rel && a.expr === exprText);
}

/** Every arithmetic operator this guard treats as "computing a figure", plus its compound-assignment
 * form (`total += x` is the same concern as `total = total + x`, just spelled differently — no known
 * instance in this package today, but cheap to close off before one exists). Comparison operators
 * (`< > <= >= === !==`) and bitwise operators are deliberately excluded — see the file header's
 * "what this still does not cover". */
const ARITHMETIC_OPERATOR_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
]);

/**
 * True when `node` is a numeric constant: a plain numeric or bigint literal (`2`, `1_000_000n`), or a
 * unary-signed one (`-1`, `+2`), optionally parenthesised (`(1)`). `2 * 3` is a constant expression,
 * not a computed figure, so a `BinaryExpression` where BOTH sides satisfy this is allowed without
 * needing an allowlist entry; anything else — a variable, a property access, a function call, a
 * template literal — on either side means the value is not known at review time, so the expression is
 * presumptively a local computation.
 */
function isNumericConstant(node: ts.Expression): boolean {
  let n: ts.Expression = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  if (ts.isPrefixUnaryExpression(n) && (n.operator === ts.SyntaxKind.MinusToken || n.operator === ts.SyntaxKind.PlusToken)) {
    return isNumericConstant(n.operand);
  }
  return ts.isNumericLiteral(n) || ts.isBigIntLiteral(n);
}

/**
 * Walks the whole AST (`ts.forEachChild` recurses into every nesting depth — arrow function bodies,
 * call arguments, ternaries, a template literal's `${...}` holes — the same way the parser itself
 * does). Returns the exact text of every arithmetic `BinaryExpression` that is neither a numeric
 * constant on both sides nor on the reviewed allowlist (`violations`), alongside the allowlist KEY
 * (`${rel}::${exprText}`) of every node that WAS let through by the allowlist (`allowedHits`) — the
 * latter is how the `it` below tallies occurrences per entry and enforces `count`.
 */
function findArithmeticViolations(sourceFile: ts.SourceFile, rel: string): { violations: string[]; allowedHits: string[] } {
  const violations: string[] = [];
  const allowedHits: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && ARITHMETIC_OPERATOR_KINDS.has(node.operatorToken.kind)) {
      const bothConstant = isNumericConstant(node.left) && isNumericConstant(node.right);
      if (!bothConstant) {
        const exprText = node.getText(sourceFile);
        if (isAllowed(rel, exprText)) allowedHits.push(`${rel}::${exprText}`);
        else violations.push(exprText);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { violations, allowedHits };
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe('@ctb/dashboard one-rule guard', () => {
  it('scans every .ts file under src (no file list is empty)', () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it('never contains binary arithmetic between two non-constant operands outside chart.ts and the reviewed allowlist', () => {
    const allowedHitCounts = new Map<string, number>();
    for (const file of FILES) {
      const rel = relative(SRC, file);
      if (rel === 'chart.ts') continue; // the one sanctioned lovelace->float conversion, itself routed through adaStr — see the export-surface test below
      const { violations, allowedHits } = findArithmeticViolations(parse(file), rel);
      expect(violations, `${rel}: local arithmetic: ${violations.join(' | ')}`).toEqual([]);
      for (const hit of allowedHits) allowedHitCounts.set(hit, (allowedHitCounts.get(hit) ?? 0) + 1);
    }
    // Every allowlist entry is pinned to a specific NUMBER of occurrences (see the comment on
    // `ALLOWED_ARITHMETIC` above) — a second, unreviewed instance of the same text passes the
    // per-node `isAllowed` check above (it can't tell "the reviewed site" from "a new site that
    // happens to reuse the same text"), but fails HERE, because the tally no longer matches what was
    // reviewed.
    for (const allowed of ALLOWED_ARITHMETIC) {
      const key = `${allowed.file}::${allowed.expr}`;
      const actual = allowedHitCounts.get(key) ?? 0;
      expect(
        actual,
        `${key}: expected exactly ${allowed.count} occurrence(s) (reviewed site: ${allowed.because}) but found ${actual} — a new occurrence of this exact allowlisted text is not automatically reviewed; add a distinct, separately-reviewed allowlist entry, or bump \`count\` only after confirming the new site by hand`,
      ).toBe(allowed.count);
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
   * `chart.ts` is exempt from the arithmetic scan above because it is spec's one sanctioned
   * lovelace-to-float conversion site — but that exemption previously came with no guardrail on what
   * ELSE could live in the file. The original defect (a hand-rolled ratio/percentage helper) could be
   * driven straight back through it: define `export function pctOf(a, b) { return (a - b) / b * 100;
   * }` in `chart.ts`, import it from a page, and the arithmetic scan never sees it (this file is
   * skipped by name, not by content). This pins the file's exported surface to exactly the two exports
   * the spec sanctions, so a new export there fails loudly and forces a reviewed conversation instead
   * of a silent pass-through.
   *
   * Round 4 (this round) replaces a `^export\s+(?:async\s+)?(?:function|const)\s+…` SOURCE-TEXT regex
   * with a walk of the same `ts.SourceFile` the arithmetic scan above already parses — the identical
   * lesson as round 3's rewrite of that scan, applied to this one. The regex matched only one export
   * SHAPE (`export function name`/`export const name` at the start of a line) and a reviewer defeated
   * it four ways, all still exporting real, callable, un-reviewed surface from the file:
   *   - `function pctOf(){…}` defined plainly, then re-exported via a separate `export { pctOf };` —
   *     the regex only looks at the declaration site, never at a bare `export { … }` specifier list.
   *   - `export class Pct { static of(a,b){ return ((a-b)/b)*100; } }` — a class, not a `function`/
   *     `const`, so the regex's own alternation excludes it by construction.
   *   - `export let scaleFactor = 100;` — `let`, not `const`; one keyword outside the regex's alternation.
   *   - `export default function pctOf(){…}` — the regex requires a name to immediately follow
   *     `function`/`const`, but a default export's runtime-visible name is `default`, not the
   *     function's own identifier, and the regex has no `default` branch at all.
   *   - `export * from './somewhere.js'` (not exercised by the injection table below, but the same
   *     family) evades it too — nothing about a re-export matches `function`/`const` at all.
   * A parenthesized `expr` sub-tree with more branches added to the regex only buys the NEXT bypass —
   * the identical trap round 3's header called out for the arithmetic scanner. `collectChartExports`
   * below instead reads the export surface off `ts.SourceFile.statements` directly, covering every
   * export FORM the language has: an exported `FunctionDeclaration`/`ClassDeclaration` (recording
   * `default` when the node also carries the `default` modifier, since that is the name a consumer
   * actually imports), an exported `VariableStatement`'s declared identifiers (`const`/`let`/`var`
   * alike — the AST does not care which keyword introduced it), a bare `export { name }` /
   * `export { local as name }` specifier list (recording the EXPORTED name, i.e. `.name`, not
   * `.propertyName`), `export default <expr>;` (an `ExportAssignment`, recorded as `default`), and
   * `export * from '...'` / `export * as ns from '...'` (an `ExportDeclaration` with no
   * `exportClause` — its real names live in another module and are not resolvable without a full
   * `ts.Program`/type checker, so it is recorded as a single non-matching sentinel that fails the
   * exact-set comparison below rather than being silently skipped).
   */
  function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
  }

  function collectChartExports(sourceFile: ts.SourceFile): Set<string> {
    const exported = new Set<string>();
    for (const stmt of sourceFile.statements) {
      const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
      if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
        exported.add(isDefault ? 'default' : (stmt.name?.text ?? 'default'));
      } else if (ts.isVariableStatement(stmt) && hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) exported.add(decl.name.text);
        }
      } else if (ts.isExportAssignment(stmt)) {
        exported.add('default'); // `export default <expr>;`
      } else if (ts.isExportDeclaration(stmt)) {
        if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
          for (const spec of stmt.exportClause.elements) exported.add(spec.name.text);
        } else {
          // `export * from '...'` / `export * as ns from '...'` — the real names come from whatever
          // module is re-exported and are not knowable from this file's own AST. Record a sentinel
          // that can never equal a real export name, so this fails the exact-set check below instead
          // of silently passing through an unreviewed re-export.
          exported.add('*(re-export — names not statically known from this file)');
        }
      }
    }
    return exported;
  }

  it("chart.ts's exported surface stays pinned to exactly {equitySeries, chartHtml} — the one file this guard exempts from the arithmetic scan", () => {
    const chartFile = FILES.find((f) => relative(SRC, f) === 'chart.ts');
    if (chartFile === undefined) throw new Error('chart.ts not found under src — has it moved? the arithmetic-scan exemption above references it by this exact relative path');
    const exported = collectChartExports(parse(chartFile));
    expect(exported, "chart.ts exports something beyond {equitySeries, chartHtml} — a new export widens the file's exemption from the one-rule guard's arithmetic scan and needs its own review, not a silent pass-through").toEqual(new Set(['equitySeries', 'chartHtml']));
  });
});
