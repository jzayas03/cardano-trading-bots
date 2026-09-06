import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { msUntilNextBoundary, sleep } from '../src/schedule.js';

describe('msUntilNextBoundary', () => {
  it('waits to the next interval boundary', () => {
    expect(msUntilNextBoundary(new Date('2026-09-05T15:07:41Z'), 300)).toBe(139_000);
  });
  it('waits a full interval when exactly on a boundary', () => {
    expect(msUntilNextBoundary(new Date('2026-09-05T15:05:00Z'), 300)).toBe(300_000);
  });
});

describe('sleep', () => {
  it('removes its abort listener after completing normally, so a long-lived signal does not accumulate listeners', async () => {
    const ac = new AbortController();
    await sleep(1, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('resolves promptly on abort and still leaves no abort listener behind', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const start = Date.now();
    await sleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });
});
