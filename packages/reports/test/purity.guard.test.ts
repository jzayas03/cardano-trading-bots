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
const FORBIDDEN = [/from ['"](pg|@ctb\/db|@ctb\/cli|@ctb\/collector|@ctb\/candles|node:child_process|node:fs|node:net|node:http)(\/[^'"]*)?['"]/];

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
  it('imports nothing that reaches a database, a process or the filesystem', () => {
    expect(FILES.length).toBeGreaterThan(5);
    for (const file of FILES) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) expect(text, `${rel} matches ${re}`).not.toMatch(re);
    }
  });
});
