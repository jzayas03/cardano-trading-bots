import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const FLOOR = [0, 33, 0] as const;
const parse = (v: string): number[] => v.replace(/^[^\d]*/, '').split('.').map(Number);
const atLeast = (v: string): boolean => {
  const [a = 0, b = 0, c = 0] = parse(v);
  return a > FLOOR[0] || (a === FLOOR[0] && (b > FLOOR[1] || (b === FLOOR[1] && c >= FLOOR[2])));
};

/**
 * Dexter 5.4.10 declares axios ^0.26.1, which carries 23 GitHub advisories (10 high), every one of
 * them patched in 0.33.0. The only thing keeping the fix in place is the root `overrides` entry, and
 * an override is one tidy-up away from vanishing with nothing failing. This pins both halves: the
 * manifest asks for it, and the install actually delivered it.
 */
describe('axios override (chore/axios-override)', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { overrides?: Record<string, string> };
  it('the root package.json overrides axios to at least 0.33.0', () => {
    const spec = pkg.overrides?.['axios'];
    expect(spec, 'overrides.axios is missing from the root package.json').toBeDefined();
    expect(atLeast(spec!), `overrides.axios is ${spec}, below the 0.33.0 advisory floor`).toBe(true);
  });
  it('the installed axios satisfies that floor', () => {
    const version = (createRequire(import.meta.url)('axios/package.json') as { version: string }).version;
    expect(atLeast(version), `installed axios is ${version}`).toBe(true);
  });
  it('the floor comparison itself is not vacuous', () => {
    expect(atLeast('0.26.1')).toBe(false);
    expect(atLeast('0.32.9')).toBe(false);
    expect(atLeast('0.33.0')).toBe(true);
    expect(atLeast('^0.33.0')).toBe(true);
    expect(atLeast('1.0.0')).toBe(true);
  });
});
