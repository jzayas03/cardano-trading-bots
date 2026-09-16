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

/**
 * The dead-man's switch measures the watchdog: `alive` is sent only after a verdict exists, and
 * the report's outcome never feeds the exit code (FR-015: a report failure must not turn a
 * healthy cycle into a failed unit, nor a failed cycle into a healthy one).
 */
describe('watch reports to the dead-man\'s switch', () => {
  it('calls decideReport( and report(', () => {
    expect(SRC).toContain('decideReport(');
    expect(SRC).toMatch(/\breport\(/);
  });

  it('does so AFTER the verdict is computed', () => {
    const verdictAt = SRC.indexOf('verdict(checks)');
    expect(verdictAt).toBeGreaterThan(-1);
    expect(SRC.indexOf('decideReport(')).toBeGreaterThan(verdictAt);
    expect(SRC.search(/\breport\(/)).toBeGreaterThan(verdictAt);
  });

  it('never assigns process.exitCode from the report result', () => {
    for (const line of SRC.split('\n')) {
      if (!/process\.exitCode\s*=/.test(line)) continue;
      expect(line, line).not.toMatch(/\b(result|outcome|reportResult)\b/);
    }
  });

  it('reads the URL from config and hands it to report(', () => {
    expect(SRC).toMatch(/report\(\s*cfg\.healthcheckUrl/);
  });
});
