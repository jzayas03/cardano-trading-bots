import type { FeedCounters } from '@ctb/engine';
import { describe, expect, it } from 'vitest';
import { accumulateFeedCounters, isTransientPgError, parsePaperArgs, tickFailureAbortReason } from '../src/commands/paper.js';
import type { FeedTickInfo } from '../src/liveFeed.js';

const tick = (over: Partial<FeedTickInfo> = {}): FeedTickInfo => ({
  boundary: new Date('2026-09-06T12:00:00.000Z'), built: 1, yielded: 1, skippedStale: 0,
  failed: false, emptyBoundary: false, consecutiveFailures: 0, lastError: null, ...over,
});

/**
 * Finding I5: `liveCandleFeed` swallowed every error and looped forever, so a paper run whose
 * database or candle builder was permanently broken kept heartbeating and kept reporting
 * `status = 'running'` while never trading again — a healthy-looking process producing nothing.
 * A streak of consecutive failures (any clean tick resets it) is what separates a blip from a run
 * that should stop and say why.
 */
describe('tickFailureAbortReason', () => {
  it('does not abort below the threshold', () => {
    expect(tickFailureAbortReason(tick({ failed: true, consecutiveFailures: 11, lastError: 'boom' }), 12)).toBeNull();
  });

  it('aborts at the threshold, naming the last error so the stop reason is diagnosable', () => {
    expect(tickFailureAbortReason(tick({ failed: true, consecutiveFailures: 12, lastError: 'connection terminated' }), 12))
      .toBe('feed failing: connection terminated');
  });

  it('aborts past the threshold too', () => {
    expect(tickFailureAbortReason(tick({ failed: true, consecutiveFailures: 30, lastError: 'boom' }), 12)).toBe('feed failing: boom');
  });

  it('never aborts on a clean tick, however many failures came before it', () => {
    expect(tickFailureAbortReason(tick({ failed: false, consecutiveFailures: 0 }), 1)).toBeNull();
  });

  it('names the failure even when the feed could not produce a message', () => {
    expect(tickFailureAbortReason(tick({ failed: true, consecutiveFailures: 12, lastError: null }), 12)).toBe('feed failing: unknown error');
  });

  it('is disabled by --max-tick-failures 0, for an operator who wants the old forever-retry', () => {
    expect(tickFailureAbortReason(tick({ failed: true, consecutiveFailures: 999, lastError: 'boom' }), 0)).toBeNull();
  });
});

/** Finding I4: the counters are running totals; a failed boundary still counts as a tick. */
describe('accumulateFeedCounters', () => {
  const zero: FeedCounters = { ticks: 0, built: 0, yielded: 0, skippedStale: 0, emptyBoundaries: 0, tickFailures: 0 };

  it('adds one tick and the boundary own numbers', () => {
    expect(accumulateFeedCounters(zero, tick({ built: 2, yielded: 3, skippedStale: 1 })))
      .toEqual({ ticks: 1, built: 2, yielded: 3, skippedStale: 1, emptyBoundaries: 0, tickFailures: 0 });
  });

  it('counts an empty boundary and a failed boundary separately', () => {
    const empty = accumulateFeedCounters(zero, tick({ built: 0, yielded: 0, emptyBoundary: true }));
    expect(empty).toMatchObject({ ticks: 1, emptyBoundaries: 1, tickFailures: 0 });
    const failed = accumulateFeedCounters(empty, tick({ built: 0, yielded: 0, failed: true, consecutiveFailures: 1, lastError: 'x' }));
    expect(failed).toMatchObject({ ticks: 2, emptyBoundaries: 1, tickFailures: 1 });
  });

  it('does not mutate the totals it is given', () => {
    const before = { ...zero };
    accumulateFeedCounters(zero, tick());
    expect(zero).toEqual(before);
  });
});

/**
 * The commit sink retries only what a retry can fix. A constraint violation or a type error is a bug
 * that will fail identically five times, and retrying it just delays the abort by the whole budget;
 * a dropped connection or a serialization failure is exactly what a retry exists for.
 */
describe('isTransientPgError', () => {
  const withCode = (code: string): Error => Object.assign(new Error(`pg said ${code}`), { code });

  it('treats the connection-exception class (08xxx) as transient', () => {
    for (const code of ['08000', '08003', '08006', '08001', '08004', '08007', '08P01']) {
      expect(isTransientPgError(withCode(code)), code).toBe(true);
    }
  });

  it('treats admin shutdown, serialization failure, and deadlock as transient', () => {
    expect(isTransientPgError(withCode('57P01'))).toBe(true);
    expect(isTransientPgError(withCode('40001'))).toBe(true);
    expect(isTransientPgError(withCode('40P01'))).toBe(true);
  });

  it('treats socket-level errors as transient', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND']) {
      expect(isTransientPgError(withCode(code)), code).toBe(true);
    }
    expect(isTransientPgError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientPgError(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  it('does NOT retry a constraint violation, a bad type, or an undefined column', () => {
    expect(isTransientPgError(withCode('23505'))).toBe(false); // unique_violation
    expect(isTransientPgError(withCode('23503'))).toBe(false); // foreign_key_violation
    expect(isTransientPgError(withCode('42703'))).toBe(false); // undefined_column
    expect(isTransientPgError(withCode('22P02'))).toBe(false); // invalid_text_representation
  });

  it('does not treat a plain programming error as transient', () => {
    expect(isTransientPgError(new TypeError('x is not a function'))).toBe(false);
    expect(isTransientPgError('a string')).toBe(false);
    expect(isTransientPgError(null)).toBe(false);
  });

  it('does not confuse a 5xx-looking substring in a message for a pg failure', () => {
    // The HTTP classifier in @ctb/collector matches on message text; this one must not, or an error
    // mentioning a pool with 500000 lovelace would be retried as if the database had hiccuped.
    expect(isTransientPgError(new Error('pool reserve 503000 is below the floor'))).toBe(false);
  });
});

describe('parsePaperArgs --max-tick-failures (finding I5)', () => {
  it('defaults to 12', () => {
    expect(parsePaperArgs(['ma-crossover', 'SNEK']).maxTickFailures).toBe(12);
  });

  it('parses an explicit value, including 0 to disable the abort', () => {
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--max-tick-failures', '3']).maxTickFailures).toBe(3);
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--max-tick-failures', '0']).maxTickFailures).toBe(0);
  });

  it('rejects a negative value', () => {
    expect(() => parsePaperArgs(['ma-crossover', 'SNEK', '--max-tick-failures', '-1'])).toThrow(/--max-tick-failures/);
  });
});
