import { describe, expect, it } from 'vitest';
import { msUntilNextBoundary } from '../src/schedule.js';

describe('msUntilNextBoundary', () => {
  it('waits to the next interval boundary', () => {
    expect(msUntilNextBoundary(new Date('2026-09-05T15:07:41Z'), 300)).toBe(139_000);
  });
  it('waits a full interval when exactly on a boundary', () => {
    expect(msUntilNextBoundary(new Date('2026-09-05T15:05:00Z'), 300)).toBe(300_000);
  });
});
