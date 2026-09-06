import { describe, expect, it } from 'vitest';
import { assertFakeAllowed } from '../src/fakeWalk.js';
import { parseFakeCollectorArgs } from '../src/commands/devFakeCollector.js';

/**
 * Synthetic data can never be mistaken for real (global constraint). This guard is the only thing
 * standing between `dev:fake-collector` and writing `Fake` pool snapshots into whatever database
 * `DATABASE_URL` happens to point at — a remote/pilot database with this env var unset is refused, a
 * localhost database without the opt-in env var is refused, and only both together are accepted.
 */
describe('dev:fake-collector guard: assertFakeAllowed', () => {
  it('refuses when CTB_ALLOW_FAKE_DATA is not exactly "1"', () => {
    expect(() => assertFakeAllowed({}, 'postgres://ctb:ctb_local_only@localhost:5433/ctb')).toThrow(/CTB_ALLOW_FAKE_DATA=1/);
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '0' }, 'postgres://ctb:ctb_local_only@localhost:5433/ctb')).toThrow(/CTB_ALLOW_FAKE_DATA=1/);
  });

  it('refuses a non-localhost database host even with the env var set', () => {
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, 'postgres://ctb:pw@prod-db.internal:5432/ctb'))
      .toThrow(/localhost database, got host prod-db\.internal/);
  });

  it('accepts localhost and 127.0.0.1 with the env var set', () => {
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, 'postgres://ctb:ctb_local_only@localhost:5433/ctb')).not.toThrow();
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, 'postgres://ctb:ctb_local_only@127.0.0.1:5433/ctb')).not.toThrow();
  });
});

describe('parseFakeCollectorArgs', () => {
  it('defaults intervalSec=60, seed=42, once=false', () => {
    expect(parseFakeCollectorArgs(['SNEK'])).toEqual({ ticker: 'SNEK', intervalSec: 60, seed: 42, once: false });
  });

  it('requires a ticker', () => {
    expect(() => parseFakeCollectorArgs([])).toThrow(/usage: dev:fake-collector/);
  });

  it('parses --interval-sec, --seed, and --once', () => {
    expect(parseFakeCollectorArgs(['SNEK', '--interval-sec', '30', '--seed', '7', '--once']))
      .toEqual({ ticker: 'SNEK', intervalSec: 30, seed: 7, once: true });
  });

  it('rejects a non-positive --interval-sec', () => {
    expect(() => parseFakeCollectorArgs(['SNEK', '--interval-sec', '0'])).toThrow(/--interval-sec needs a positive number/);
  });

  it('rejects a non-integer --seed', () => {
    expect(() => parseFakeCollectorArgs(['SNEK', '--seed', '4.2'])).toThrow(/--seed needs an integer/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseFakeCollectorArgs(['SNEK', '--bogus'])).toThrow(/unknown flag --bogus/);
  });
});
