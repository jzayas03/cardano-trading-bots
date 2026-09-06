import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PG_ENABLED, withTestSchema } from './helpers.js';

// Reviewer finding F8: withTestSchema created the admin pool and issued CREATE SCHEMA
// outside its try/finally, so a CREATE SCHEMA failure (which does happen: a name collision,
// a role/permission problem, the DB briefly unreachable) leaked the admin pg.Pool forever.
describe.skipIf(!PG_ENABLED)('withTestSchema', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ends the admin pool even when CREATE SCHEMA fails, instead of leaking it', async () => {
    const endSpy = vi.spyOn(pg.Pool.prototype, 'end');
    // Intercepts the very first pool.query() call withTestSchema makes, which is the admin
    // pool's `CREATE SCHEMA ...` — before fn(db) or DROP SCHEMA can ever run.
    vi.spyOn(pg.Pool.prototype, 'query').mockRejectedValueOnce(new Error('simulated CREATE SCHEMA failure'));

    let fnCalled = false;
    await expect(withTestSchema(async () => { fnCalled = true; })).rejects.toThrow('simulated CREATE SCHEMA failure');

    expect(fnCalled).toBe(false);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});
