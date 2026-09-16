import { describe, expect, it } from 'vitest';
import { VENUE_NAMES } from '@ctb/collector/pure';
import { VENUE_COSTS } from '../src/index.js';

/** A cost without a source and a date is a guess that will be read as a fact. */
describe('every venue cost carries provenance', () => {
  it('has a non-empty source, an ISO date, and a basis for every venue', () => {
    for (const v of VENUE_NAMES) {
      const c = VENUE_COSTS[v];
      expect(c.source.length, v).toBeGreaterThan(8);
      expect(c.readAt, v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['documented', 'assumed', 'measured']).toContain(c.basis);
      if (c.basis === 'documented') expect(c.source, v).toMatch(/^https?:\/\/|\.pdf/);
      // 'measured' OUTRANKS 'documented' — it is what the chain took, not what a page claims, and it
      // is the only grade that survives Principle I. The price of that rank is evidence: the source
      // must name the reading and the dated note that holds the raw data, so nobody can promote a
      // guess by editing one word. (2026-09-16: Minswap's docs said zero while every live V2 order
      // paid 2 ADA.)
      if (c.basis === 'measured') {
        expect(c.source, v).toMatch(/MEASURED ON CHAIN \d{4}-\d{2}-\d{2}/);
        expect(c.source, v).toMatch(/docs\/ops\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md/);
      }
    }
  });
});
