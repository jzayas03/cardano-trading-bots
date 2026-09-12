import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `missingTicksCell` refuses to print a count when the configured and observed cadences disagree, and
 * `cadence.test.ts` proves that refusal. Neither can see the thing that actually went wrong on
 * 2026-09-12: the CALLER handed over the wrong interval. `status` printed
 * `ticks missing in last 24h (approx): -191` and the digest printed a clamped `(0 missing)` because
 * both passed `cfg.intervalSec` — the 900 s CANDLE interval — where the 300 s interval at which a
 * `collector_runs` row is actually written belongs.
 *
 * With the refusal in place a regression here no longer prints a wrong number; it prints `n/a` and a
 * cadence mismatch forever, which is honest but useless. So the wiring is pinned directly: every site
 * that feeds a row-count query must derive its interval from `effectiveTickIntervalSec`.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CALL_SITES: Array<{ name: string; src: string }> = [
  { name: 'status', src: read('../src/commands/status.ts') },
  { name: 'watch', src: read('../src/commands/watch.ts') },
  { name: 'doctor', src: read('../src/commands/doctor.ts') },
  { name: 'dashboard', src: read('../src/commands/dashboard.ts') },
];

/** `digestInput(` / `missingTicksApprox(` with `cfg.intervalSec` as the FIRST argument. */
const BARE_CANDLE_INTERVAL = /(?:digestInput|missingTicksApprox)\(\s*cfg\.intervalSec\b/;

describe('the row-counting queries are fed the row-writing interval', () => {
  it.each(CALL_SITES)('$name derives its interval from effectiveTickIntervalSec', ({ src }) => {
    expect(src).toContain('effectiveTickIntervalSec');
  });

  it.each(CALL_SITES)('$name never passes the candle interval straight into a row count', ({ src }) => {
    expect(src).not.toMatch(BARE_CANDLE_INTERVAL);
  });

  /**
   * Both directions, because a guard that cannot fail is not a guard and one that fires on correct
   * code gets obeyed. The first string is the defect verbatim; the second is the fix verbatim.
   */
  it('CONTROL: the pattern fires on the 2026-09-12 defect and stays quiet on the fix', () => {
    expect('const c = await repo.missingTicksApprox(cfg.intervalSec);').toMatch(BARE_CANDLE_INTERVAL);
    expect('digestLines(await repo.digestInput(cfg.intervalSec, [...cfg.venues], now), now)').toMatch(BARE_CANDLE_INTERVAL);
    expect('const c = await repo.missingTicksApprox(effectiveTickIntervalSec(cfg));').not.toMatch(BARE_CANDLE_INTERVAL);
    expect('const c = await repo.missingTicksApprox(tickIntervalSec);').not.toMatch(BARE_CANDLE_INTERVAL);
  });

  it('CONTROL: the guard is reading the real files', () => {
    expect(CALL_SITES).toHaveLength(4);
    for (const { src } of CALL_SITES) expect(src.length).toBeGreaterThan(1_000);
    expect(read('../src/commands/status.ts')).toContain('export async function statusCommand');
  });
});
