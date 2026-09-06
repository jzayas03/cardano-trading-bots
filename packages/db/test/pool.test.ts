import { describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';

const URL = 'postgres://ctb:ctb_local_only@localhost:5433/ctb';

/**
 * Finding M4: `createPool` set only `max`, so every other bound was pg's default — which for
 * `connectionTimeoutMillis` is 0, "wait forever". A paper run is a long-lived process whose whole
 * liveness story is its heartbeat; a connect or a statement that hangs indefinitely never throws,
 * so the retry never fires, the catch never runs, and the run stops writing while still reporting
 * `status = 'running'` — the exact silent-stall shape C2's stale-heartbeat recovery exists to clean
 * up after. Bounded here so a stuck connection surfaces as an error the commit sink can retry.
 *
 * No connection is made: `new pg.Pool()` is lazy, so this reads the config it will connect WITH.
 */
describe('createPool bounds (finding M4)', () => {
  it('carries a connect timeout, a server-side statement_timeout, and a client-side query_timeout', async () => {
    const pool = createPool(URL, () => {});
    try {
      const o = pool.options as unknown as Record<string, unknown>;
      expect(o.connectionTimeoutMillis).toBe(10_000);
      expect(o.statement_timeout).toBe(30_000);
      expect(o.query_timeout).toBe(30_000);
      expect(o.max).toBe(5);
    } finally {
      await pool.end();
    }
  });

  it('registers the caller error handler for idle-client errors', async () => {
    const seen: Error[] = [];
    const pool = createPool(URL, (err) => seen.push(err));
    try {
      pool.emit('error', new Error('idle client died'), undefined as never);
      expect(seen.map((e) => e.message)).toEqual(['idle client died']);
    } finally {
      await pool.end();
    }
  });
});
