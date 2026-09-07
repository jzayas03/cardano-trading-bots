import { describe, expect, it } from 'vitest';
import { heartbeatAgeCell, isHeartbeatStale } from '../src/commands/status.js';

/**
 * Finding (Task 5 review round 1): the `status` STALE/heartbeat-age rule had no unit test at all —
 * it lived inline in a `.map()` callback inside `statusCommand`, reachable only through a live
 * Postgres run. `heartbeatAgeCell` is the same rule extracted pure: `2 * intervalSec + graceSec` is
 * the liveness bound (defaults 600/60 — the collector's default interval — when `params` lacks numeric `intervalSec`/`graceSec`); a run
 * that has never heartbeated is STALE regardless of `now`.
 */
describe('heartbeatAgeCell', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');

  it('returns the age in seconds, as a string, for a fresh heartbeat', () => {
    const heartbeatAt = new Date('2026-09-06T11:59:30.000Z'); // 30s ago
    expect(heartbeatAgeCell(heartbeatAt, {}, now)).toBe('30');
  });

  it('is not stale exactly at the bound (default 2*600+60 = 1260s)', () => {
    const heartbeatAt = new Date(now.getTime() - 1_260_000);
    expect(heartbeatAgeCell(heartbeatAt, {}, now)).toBe('1260');
  });

  // Finding M1 changed this expectation: a bare `STALE` hid HOW stale. The age is now carried with
  // it, because 30 seconds past the bound and two days past it call for different operator actions.
  it('is STALE with the age, one second past the bound', () => {
    const heartbeatAt = new Date(now.getTime() - 1_261_000);
    expect(heartbeatAgeCell(heartbeatAt, {}, now)).toBe('STALE (1261s)');
  });

  it('is a bare STALE, with no age, when the run has never heartbeated: there is no age to state', () => {
    expect(heartbeatAgeCell(null, {}, now)).toBe('STALE');
  });

  it('uses custom intervalSec/graceSec from params for the bound', () => {
    // bound = 2*10 + 5 = 25s
    const atBound = new Date(now.getTime() - 25_000);
    const pastBound = new Date(now.getTime() - 26_000);
    expect(heartbeatAgeCell(atBound, { intervalSec: 10, graceSec: 5 }, now)).toBe('25');
    expect(heartbeatAgeCell(pastBound, { intervalSec: 10, graceSec: 5 }, now)).toBe('STALE (26s)');
  });

  it('falls back to defaults (600/60) when params lack them or hold non-numeric values', () => {
    const heartbeatAt = new Date(now.getTime() - 1_260_000);
    expect(heartbeatAgeCell(heartbeatAt, {}, now)).toBe('1260');
    expect(heartbeatAgeCell(heartbeatAt, { intervalSec: 'ten', graceSec: null }, now)).toBe('1260');
  });
});

/**
 * Finding C2: the STALE rule had exactly one consumer — the `status` table cell — so `--resume`
 * could not reuse it and instead refused every `'running'` row outright, which made a run whose
 * process died without reaching its catch block (`kill -9`, OOM, lost machine) permanently
 * unresumable. The predicate is extracted here so `status` and `resumeStatusError` decide liveness
 * from the SAME bound, and a change to one can never silently disagree with the other.
 */
describe('isHeartbeatStale', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');

  it('is false for a heartbeat inside the bound', () => {
    expect(isHeartbeatStale(new Date(now.getTime() - 30_000), {}, now)).toBe(false);
  });

  it('is false exactly at the bound and true one second past it', () => {
    expect(isHeartbeatStale(new Date(now.getTime() - 1_260_000), {}, now)).toBe(false);
    expect(isHeartbeatStale(new Date(now.getTime() - 1_261_000), {}, now)).toBe(true);
  });

  it('is true for a run that has never heartbeated', () => {
    expect(isHeartbeatStale(null, {}, now)).toBe(true);
  });

  it('honours the run own intervalSec/graceSec', () => {
    expect(isHeartbeatStale(new Date(now.getTime() - 126_000), { intervalSec: 60, graceSec: 5 }, now)).toBe(true);
    expect(isHeartbeatStale(new Date(now.getTime() - 125_000), { intervalSec: 60, graceSec: 5 }, now)).toBe(false);
  });

  it('agrees with heartbeatAgeCell: every input the cell calls STALE is stale here', () => {
    for (const ageMs of [0, 100_000, 1_260_000, 1_261_000, 5_000_000]) {
      const at = new Date(now.getTime() - ageMs);
      expect(heartbeatAgeCell(at, {}, now).startsWith('STALE')).toBe(isHeartbeatStale(at, {}, now));
    }
  });
});
