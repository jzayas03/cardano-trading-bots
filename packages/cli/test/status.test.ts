import { describe, expect, it } from 'vitest';
import { heartbeatAgeCell } from '../src/commands/status.js';

/**
 * Finding (Task 5 review round 1): the `status` STALE/heartbeat-age rule had no unit test at all —
 * it lived inline in a `.map()` callback inside `statusCommand`, reachable only through a live
 * Postgres run. `heartbeatAgeCell` is the same rule extracted pure: `2 * intervalSec + graceSec` is
 * the liveness bound (defaults 300/60 when `params` lacks numeric `intervalSec`/`graceSec`); a run
 * that has never heartbeated is STALE regardless of `now`.
 */
describe('heartbeatAgeCell', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');

  it('returns the age in seconds, as a string, for a fresh heartbeat', () => {
    const heartbeatAt = new Date('2026-09-06T11:59:30.000Z'); // 30s ago
    expect(heartbeatAgeCell(heartbeatAt, {}, now)).toBe('30');
  });

  it('is not stale exactly at the bound (default 2*300+60 = 660s)', () => {
    const heartbeatAt = new Date(now.getTime() - 660_000);
    expect(heartbeatAgeCell(heartbeatAt, {}, now)).toBe('660');
  });

  it('is STALE one second past the bound', () => {
    const heartbeatAt = new Date(now.getTime() - 661_000);
    expect(heartbeatAgeCell(heartbeatAt, {}, now)).toBe('STALE');
  });

  it('is STALE when the run has never heartbeated, regardless of now', () => {
    expect(heartbeatAgeCell(null, {}, now)).toBe('STALE');
  });

  it('uses custom intervalSec/graceSec from params for the bound', () => {
    // bound = 2*10 + 5 = 25s
    const atBound = new Date(now.getTime() - 25_000);
    const pastBound = new Date(now.getTime() - 26_000);
    expect(heartbeatAgeCell(atBound, { intervalSec: 10, graceSec: 5 }, now)).toBe('25');
    expect(heartbeatAgeCell(pastBound, { intervalSec: 10, graceSec: 5 }, now)).toBe('STALE');
  });

  it('falls back to defaults (300/60) when params lack them or hold non-numeric values', () => {
    const heartbeatAt = new Date(now.getTime() - 660_000);
    expect(heartbeatAgeCell(heartbeatAt, {}, now)).toBe('660');
    expect(heartbeatAgeCell(heartbeatAt, { intervalSec: 'ten', graceSec: null }, now)).toBe('660');
  });
});
