import { describe, expect, it } from 'vitest';
import { VENUE_NAMES } from '@ctb/collector';
import { VENUE_COSTS } from '../src/index.js';

/** A cost without a source and a date is a guess that will be read as a fact. */
describe('every venue cost carries provenance', () => {
  it('has a non-empty source, an ISO date, and a basis for every venue', () => {
    for (const v of VENUE_NAMES) {
      const c = VENUE_COSTS[v];
      expect(c.source.length, v).toBeGreaterThan(8);
      expect(c.readAt, v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['documented', 'assumed']).toContain(c.basis);
      if (c.basis === 'documented') expect(c.source, v).toMatch(/^https?:\/\/|\.pdf/);
    }
  });
});
