import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The restart-cost machinery is in `@ctb/collector` and unit-tested there against fakes. This guard
 * covers the one thing those tests CANNOT see: whether `collect` actually uses it.
 *
 * Delete `source.hydrate(restart.pools)` from the collect loop and every test in
 * `tickRestartCost.test.ts` stays green, because they hydrate their own source. The collector would
 * then cold-start on every restart and buy a ~5,700-call sweep -- the 2026-09-08 defect, back, with
 * a green suite. There is no cheaper honest check: exercising the real path needs Blockfrost and a
 * live pool set, so the wiring is pinned in the source instead.
 *
 * If you move this wiring, move the guard with it. A guard that silently matches nothing is worse
 * than no guard, so each assertion below names the symbol it looks for.
 */
const SRC = readFileSync(fileURLToPath(new URL('../src/commands/collect.ts', import.meta.url)), 'utf8');

describe('collect wires the restart-cost controls', () => {
  it('reads the persisted state before the loop', () => {
    // Without this the discovery clock starts null, which alone forces a sweep.
    expect(SRC).toMatch(/await\s+repo\.restartState\(/);
    expect(SRC).toMatch(/lastDiscoveryAt:\s*restart\.lastDiscoveryAt/);
    expect(SRC).toMatch(/callsSpentToday:\s*restart\.callsSpentToday/);
    expect(SRC).toMatch(/lastDiscoveryCost:\s*restart\.lastDiscoveryCost/);
  });

  it('hydrates the pool set from it', () => {
    // Without this `knownPoolCount()` is 0, which INDEPENDENTLY forces a sweep -- seeding the clock
    // alone does not fix the bug, and this assertion is what stops someone concluding that it does.
    expect(SRC).toMatch(/source\.hydrate\(\s*restart\.pools\s*\)/);
  });

  it('passes the cache and the ceiling into every tick', () => {
    expect(SRC).toMatch(/poolCache:\s*repo/);
    expect(SRC).toMatch(/dailyCallCeiling:\s*cfg\.dailyCallCeiling/);
  });

  it('CONTROL: the guard is reading the real file, not an empty string', () => {
    // An assertion against nothing passes forever. Anchor on something that must exist regardless of
    // how this file is refactored.
    expect(SRC.length).toBeGreaterThan(1_000);
    expect(SRC).toContain('export async function collectCommand');
  });
});
