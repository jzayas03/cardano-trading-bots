import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The checks are pure and tested in `@ctb/reports`. This covers the one thing those tests cannot
 * see: whether `watch` — the thing systemd actually runs every fifteen minutes — calls them.
 *
 * That distinction is not academic here. On 2026-09-08 the watchdog was scheduled, ran fifteen
 * times, exited 0 every time, and reported nothing through four hours of a dead feed. A check that
 * exists and is not wired in is indistinguishable from one that was never written.
 */
const SRC = readFileSync(fileURLToPath(new URL('../src/commands/watch.ts', import.meta.url)), 'utf8');

describe('watch calls the checks that would have caught 2026-09-08', () => {
  it.each(['checkTickProductivity', 'checkRecurringTickErrors', 'checkQuotaSpend'])('calls %s', (fn) => {
    expect(SRC).toMatch(new RegExp(`checks\\.push\\(${fn}\\(`));
  });

  it('feeds them real run rows and the configured ceiling', () => {
    expect(SRC).toMatch(/await\s+repo\.lastRuns\(/);
    expect(SRC).toMatch(/cfg\.dailyCallCeiling/);
  });

  it('CONTROL: the guard is reading the real file', () => {
    expect(SRC).toContain('export async function watchCommand');
    expect(SRC.length).toBeGreaterThan(1_000);
  });
});
