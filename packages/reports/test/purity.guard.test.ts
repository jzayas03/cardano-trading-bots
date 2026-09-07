import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');
const FORBIDDEN = [/from '(pg|@ctb\/db|@ctb\/cli|@ctb\/collector|@ctb\/candles|node:child_process|node:fs|node:net|node:http)'/];

/** @ctb/reports is the set of functions two consumers (cli, dashboard) must agree on. It stays pure: no database, no process, no filesystem. */
describe('@ctb/reports purity', () => {
  it('imports nothing that reaches a database, a process or the filesystem', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(resolve(SRC, f), 'utf8');
      for (const re of FORBIDDEN) expect(text, `${f} matches ${re}`).not.toMatch(re);
    }
  });
});
