/**
 * FR-006: the two fill-time bps measures must never be summed, and no prose may decompose a cost as
 * a pool fee ALONGSIDE an impact term.
 *
 * Why this is a control and not a comment. `slippageBps` is the fill against the decision-time mid
 * and `priceImpactBps` is the fill against the t+1 pool mid. Verified from the arithmetic in
 * simExecutor.ts, BOTH already contain the pool fee, because cpmmAmountOut applies feeBps to the
 * fill while neither reference price does. Adding them charges the pool fee twice. A 2026-09-09
 * summary decomposed 86 bps as "pool fee 30 + impact 34 + spread 22", charging the fee twice AND
 * inventing a spread term, and that decomposition still drives a published per-token floor table.
 *
 * DOCS ARE IN SCOPE, not only source. No code in this repo has ever summed them; every live
 * instance of this defect is in a markdown file a human reads and quotes. A guard that scanned only
 * `src` would pass while the defect went on being published.
 *
 * The POSITIVE CONTROL below is not decoration. A detector nobody proved can detect is worthless --
 * this repo has already shipped a `shellcheck disable` bound to the wrong command that had never
 * worked once. If the fixtures stop being flagged, this guard has died silently.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');

/** Summing the two measures, either order, camel or snake. */
const SUMMED_MEASURES =
  /\b(slippage_?bps\s*\+\s*price_?impact_?bps|price_?impact_?bps\s*\+\s*slippage_?bps)\b/i;

/** A prose decomposition charging a pool fee alongside an impact term. */
const POOL_FEE_PLUS_IMPACT = /pool\s+fee\s*\+\s*[^\n]{0,40}\bimpact\b/i;

const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'summed bps measures', re: SUMMED_MEASURES },
  { name: 'pool fee charged alongside impact', re: POOL_FEE_PLUS_IMPACT },
];

/**
 * Files that legitimately DESCRIBE the defect, each with its reason. An entry names a file and why,
 * so this list cannot quietly become a way of passing.
 */
const ALLOWED = new Map<string, string>([
  ['packages/reports/test/noSummedBpsMeasures.guard.test.ts', 'this guard; contains the positive-control fixtures'],
  ['packages/reports/src/costFloor.ts', 'its header states the rule it obeys'],
  ['specs/002-cost-floor-distribution/spec.md', 'FR-006 quotes the defect it forbids'],
  ['specs/002-cost-floor-distribution/research.md', 'R7 records where the defect is live'],
  ['specs/002-cost-floor-distribution/plan.md', 'restates the rule'],
  ['specs/002-cost-floor-distribution/tasks.md', 'T026-T031 quote the offending formula'],
  ['specs/002-cost-floor-distribution/data-model.md', 'states what must never be added'],
  ['specs/002-cost-floor-distribution/contracts/cost-floor.md', 'specifies this guard'],
  ['specs/002-cost-floor-distribution/quickstart.md', 'scenario 3 quotes the formula the guard must flag'],
  ['docs/specs/2026-09-08-m6-execution.md', 'the source that first named the error'],
]);

/**
 * KNOWN-BAD, NOT YET FIXED. Correcting these changes a published per-token floor table
 * (ASCEND 477, STRIKE 411, SNEK 371, WMTX 561 bps), which is a cost-model claim and a founder
 * decision under Constitution Principle I. Recorded by T030/T031 of
 * specs/002-cost-floor-distribution rather than silently repaired. DO NOT widen this list: it is
 * two paths, and a third belongs in a fix, not here.
 */
const KNOWN_UNFIXED = new Map<string, string>([
  ['docs/ops/2026-09-09-strategy-state.md', 'line 40 "Floor = 2 x (pool fee + impact(depth) + 22 bps spread + 22 bps batcher)"; drives the per-token floor table'],
  ['docs/ops/2026-09-09-token-choice-ada.md', 'lines 14-23 carry the same formula; founder-gated to correct'],
]);

function walk(dir: string, match: (f: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match(full)) out.push(full);
  }
  return out;
}

function scanTargets(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    files.push(...walk(join(ROOT, 'packages', pkg, 'src'), (f) => f.endsWith('.ts')));
  }
  files.push(...walk(join(ROOT, 'docs'), (f) => f.endsWith('.md')));
  files.push(...walk(join(ROOT, 'specs'), (f) => f.endsWith('.md')));
  return files;
}

describe('the two overlapping bps measures are never summed', () => {
  it('POSITIVE CONTROL: the detector flags known-bad text', () => {
    const fixtures = [
      'const total = slippageBps + priceImpactBps;',
      'const total = price_impact_bps + slippage_bps;',
      'SELECT slippage_bps + price_impact_bps AS total',
      'Floor = 2 x (pool fee + impact(depth) + 22 bps spread + 22 bps batcher)',
    ];
    for (const f of fixtures) {
      expect(PATTERNS.some((p) => p.re.test(f)), `not flagged: ${f}`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the detector does not flag legitimate adjacency', () => {
    const benign = [
      'slippageBps, priceImpactBps, status',
      'expect(o.slippageBps).toBe(86); expect(o.priceImpactBps).toBe(34);',
      'the pool fee is already inside both measures',
    ];
    for (const b of benign) {
      expect(PATTERNS.some((p) => p.re.test(b)), `false positive: ${b}`).toBe(false);
    }
  });

  it('no source or document sums them', () => {
    const offenders: string[] = [];
    for (const file of scanTargets()) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel) || KNOWN_UNFIXED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const p of PATTERNS) {
        if (p.re.test(text)) offenders.push(`${rel}: ${p.name}`);
      }
    }
    expect(offenders, `files summing the two measures:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the known-unfixed files are STILL unfixed, so the skip cannot outlive the defect', () => {
    // If someone fixes one of these, this fails and tells them to remove it from KNOWN_UNFIXED.
    // A skip list that survives its own reason is how a control rots into decoration.
    for (const [rel, why] of KNOWN_UNFIXED) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      const stillBad = PATTERNS.some((p) => p.re.test(text));
      expect(stillBad, `${rel} no longer matches (${why}) -- remove it from KNOWN_UNFIXED`).toBe(true);
    }
  });
});
