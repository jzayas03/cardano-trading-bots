import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');

/**
 * MINOR (final review): the previous regex required the closing quote to sit IMMEDIATELY after the
 * forbidden specifier — `from '(pg|...)'` — so any deep or scoped SUBPATH import slipped past
 * entirely: `node:fs/promises` (still the filesystem), `pg/lib/utils` (still the database driver), or
 * `@ctb/db/pool` all match none of the alternatives, because none of them end the string right there.
 * The optional `(\/[^'"]*)?` lets each forbidden specifier match itself OR itself-plus-a-subpath,
 * closing that hole without narrowing what already matched. Single- and double-quoted specifiers are
 * both accepted, since nothing in this guard's job depends on which quote style a future import uses.
 */
const FORBIDDEN = [/from ['"](pg|@ctb\/db|@ctb\/cli|@ctb\/collector|@ctb\/candles|node:child_process|node:fs|node:net|node:http|node:crypto)(\/[^'"]*)?['"]/];

/**
 * A CLOCK. specs/004 T048 asked this guard to confirm the package reads no clock and imports no
 * `node:crypto`, and it turned out to check NEITHER — `node:crypto` was missing from the list above
 * and nothing looked for a clock at all, so two thirds of what the guard was credited with was
 * never enforced. Both are closed here, with positive controls, because a guard nobody has seen
 * fail is a claim rather than a control.
 *
 * `new Date(x)` and `d.getTime()` are fine: those read a timestamp the CALLER supplied. What is
 * forbidden is asking the machine what time it is now, which makes a report's output depend on when
 * it ran.
 */
const CLOCK = /(\bDate\s*\.\s*now\s*\(|new\s+Date\s*\(\s*\)|performance\s*\.\s*now\s*\()/;

/**
 * MINOR (final review): `readdirSync(SRC)` is non-recursive — a future `src/sub/x.ts` would never be
 * LISTED here at all, not merely mismatched, so it would be silently unscanned rather than failing
 * loudly. Mirrors `packages/dashboard/test/oneRule.guard.test.ts`'s own recursive `walk` — the same
 * shape of gap, in a sibling package's guard, fixed the same way.
 */
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

/** @ctb/reports is the set of functions two consumers (cli, dashboard) must agree on. It stays pure: no database, no process, no filesystem. */
describe('@ctb/reports purity', () => {
  it('the guards catch what they claim to — positive controls', () => {
    // Added 2026-09-18 with the clock and node:crypto checks. The import regex above had no control
    // either; these three stand in for the shapes each pattern exists to reject.
    for (const bad of ["import { randomUUID } from 'node:crypto';", "import x from 'node:crypto/webcrypto';"]) {
      expect(FORBIDDEN.some((re) => re.test(bad)), bad).toBe(true);
    }
    for (const bad of ['const t = Date.now();', 'const d = new Date();', 'performance.now()', 'Date . now ()']) {
      expect(CLOCK.test(bad), bad).toBe(true);
    }
    // And does NOT reject the legitimate shapes, or every file in the package would fail.
    for (const ok of ['new Date(tickTs)', 'a.tickTs.getTime()', 'new Date(t + 900_000)']) {
      expect(CLOCK.test(ok), ok).toBe(false);
    }
  });

  it('reads no clock: output must not depend on when the report ran', () => {
    expect(FILES.length).toBeGreaterThan(5);
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${relative(SRC, file)} reads a clock`).not.toMatch(CLOCK);
    }
  });

  it('imports nothing that reaches a database, a process or the filesystem', () => {
    expect(FILES.length).toBeGreaterThan(5);
    for (const file of FILES) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) expect(text, `${rel} matches ${re}`).not.toMatch(re);
    }
  });
});
