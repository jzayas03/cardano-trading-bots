import { describe, expect, it } from 'vitest';
import { describeError } from '../src/main.js';

describe('describeError', () => {
  it('describes an AggregateError, whose own message is empty', () => {
    // The real case: `pg` fails a connection with an AggregateError carrying ECONNREFUSED for both
    // ::1 and 127.0.0.1. Its .message is '' — so `{ err: err.message }` logged NOTHING while the
    // collector died. Seen twice on the M5 host, 2026-09-08.
    const agg = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:5433'), new Error('connect ECONNREFUSED 127.0.0.1:5433')],
    );
    expect(agg.message).toBe('');
    const d = describeError(agg);
    expect(d.err).toBe('AggregateError');           // falls back to the name, never ''
    expect(d.causes).toEqual([
      'connect ECONNREFUSED ::1:5433',
      'connect ECONNREFUSED 127.0.0.1:5433',
    ]);
  });

  it('never reports an empty err, whatever it is handed', () => {
    for (const thrown of [new Error(''), new AggregateError([]), new TypeError('')]) {
      expect(describeError(thrown).err).not.toBe('');
      expect(describeError(thrown).err).toBeTruthy();
    }
  });

  it('keeps an ordinary error simple', () => {
    const d = describeError(new Error('run 138 is already running'));
    expect(d.err).toBe('run 138 is already running');
    expect(d.name).toBe('Error');
  });

  it('handles a thrown non-Error rather than losing it', () => {
    expect(describeError('boom')).toEqual({ err: 'boom' });
    expect(describeError(undefined)).toEqual({ err: 'undefined' });
  });

  it('surfaces a cause when there is one', () => {
    const d = describeError(new Error('outer', { cause: new Error('the real reason') }));
    expect(d.cause).toBe('the real reason');
  });

  it('truncates the stack rather than flooding a log line', () => {
    const d = describeError(new Error('x'));
    expect(String(d.stack).split(' | ').length).toBeLessThanOrEqual(4);
  });
});
