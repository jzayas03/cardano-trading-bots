/**
 * FR-005: the promotion gate's verdict must be identical for identical input, in this process and in
 * any other. A bootstrap resamples at random, so the ONLY randomness permitted under
 * `packages/reports/src` is a seeded PRNG.
 *
 * Why this is a control and not a comment. A determinism test that runs the current code twice keeps
 * passing forever after someone reintroduces `Math.random` somewhere else in the package — the two
 * runs would simply be wrong together. This scans the source instead, so the guarantee survives code
 * the determinism test never calls.
 *
 * The POSITIVE CONTROL below is not decoration. A detector nobody proved can detect is worthless:
 * this repo has already shipped a `shellcheck disable` bound to the wrong command that had never
 * worked once. If the fixture stops being flagged, this guard has died silently.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const ROOT = resolve(HERE, '..', '..', '..');

/** `Math.random`, however it is spelled or spaced. Not `Math.round`, not `Math.abs`. */
const AMBIENT_RANDOM = /\bMath\s*\.\s*random\b/;

const tsFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? tsFiles(full) : full.endsWith('.ts') ? [full] : [];
  });

describe('no ambient randomness in @ctb/reports', () => {
  it('POSITIVE CONTROL: the detector flags known-bad fixtures', () => {
    // If these stop matching, every assertion below is vacuous.
    for (const bad of ['const x = Math.random();', 'return Math . random ()', 'foo(Math.random)']) {
      expect(AMBIENT_RANDOM.test(bad), `should flag ${JSON.stringify(bad)}`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the detector does not flag the Math the module legitimately uses', () => {
    // bootstrap.ts is full of Math.abs, Math.exp, Math.imul, Math.sqrt, Math.cbrt. A regex that
    // caught those would be turned off within a week, which is its own way of dying.
    for (const ok of ['Math.round(x)', 'Math.abs(-1)', 'Math.imul(a, b)', 'randomise(seed)', 'mathRandomish']) {
      expect(AMBIENT_RANDOM.test(ok), `should NOT flag ${JSON.stringify(ok)}`).toBe(false);
    }
  });

  it('no source file under packages/reports/src uses Math.random', () => {
    const files = tsFiles(SRC);
    expect(files.length).toBeGreaterThan(10); // the scan found a tree, not an empty directory
    for (const f of files) {
      const rel = relative(ROOT, f);
      expect(readFileSync(f, 'utf8'), `${rel} uses Math.random`).not.toMatch(AMBIENT_RANDOM);
    }
  });
});
