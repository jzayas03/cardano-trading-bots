import { describe, expect, it } from 'vitest';
import { assertFakeAllowed, fakeWalk, mulberry32 } from '../src/fakeWalk.js';

describe('mulberry32', () => {
  it('is deterministic: the same seed reproduces the same sequence', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces floats in [0, 1) and a different sequence for a different seed', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 20; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const first1 = mulberry32(1)();
    const first2 = mulberry32(2)();
    expect(first1).not.toBe(first2);
  });
});

const START = { reserveBase: 20_000_000n, reserveQuote: 50_000n * 1_000_000n };

describe('fakeWalk', () => {
  /**
   * The "hand" pin for a PRNG (task brief): these three values were computed by actually running
   * `fakeWalk(42, 3, START)` once and reading the output back, not derived independently — the same
   * way `simExecutor.test.ts`'s hand-computed fixtures are pinned. A future change to the step
   * algorithm (draw order, ppm cap, fee bps) will legitimately need to update these three lines; a
   * change that does NOT update them but still passes means the walk stopped being deterministic.
   */
  it('reproduces the pinned first three states for seed 42', () => {
    const states = fakeWalk(42, 3, START);
    expect(states.map((s) => ({ reserveBase: s.reserveBase.toString(), reserveQuote: s.reserveQuote.toString() }))).toEqual([
      { reserveBase: '20044820', reserveQuote: '49888535194' },
      { reserveBase: '20111930', reserveQuote: '49722563607' },
      { reserveBase: '20059293', reserveQuote: '49853433394' },
    ]);
  });

  it('is deterministic: the same seed and start reproduce the same walk', () => {
    expect(fakeWalk(42, 10, START)).toEqual(fakeWalk(42, 10, START));
  });

  it('a different seed produces a different walk', () => {
    expect(fakeWalk(42, 3, START)).not.toEqual(fakeWalk(7, 3, START));
  });

  // Spec: each step applies cpmmAmountOut with a fee, so reserveBase * reserveQuote never decreases
  // from one state to the next — a real CPMM invariant, not an arbitrary reserve edit.
  it('keeps the constant-product k non-decreasing at every step', () => {
    const states = fakeWalk(42, 200, START);
    let prevK = START.reserveBase * START.reserveQuote;
    for (const s of states) {
      const k = s.reserveBase * s.reserveQuote;
      expect(k).toBeGreaterThanOrEqual(prevK);
      prevK = k;
    }
  });

  it('keeps both reserves strictly positive throughout a long walk', () => {
    for (const s of fakeWalk(42, 500, START)) {
      expect(s.reserveBase).toBeGreaterThan(0n);
      expect(s.reserveQuote).toBeGreaterThan(0n);
    }
  });
});

describe('assertFakeAllowed', () => {
  const LOCAL_URL = 'postgres://ctb:pw@localhost:5433/ctb';
  const LOOPBACK_URL = 'postgres://ctb:pw@127.0.0.1:5433/ctb';
  const REMOTE_URL = 'postgres://ctb:pw@db.example.com:5432/ctb';

  it('refuses without CTB_ALLOW_FAKE_DATA=1', () => {
    expect(() => assertFakeAllowed({}, LOCAL_URL)).toThrow(/CTB_ALLOW_FAKE_DATA=1/);
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: 'true' }, LOCAL_URL)).toThrow(/CTB_ALLOW_FAKE_DATA=1/);
  });

  it('refuses a non-localhost database host even with the env var set', () => {
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, REMOTE_URL)).toThrow(/localhost database, got host db\.example\.com/);
  });

  it('accepts localhost or 127.0.0.1 with the env var set', () => {
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, LOCAL_URL)).not.toThrow();
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, LOOPBACK_URL)).not.toThrow();
  });

  // A subdomain LABEL of localhost is not the host — `new URL` parsing (not a string prefix check)
  // must reject it the same as any other remote host.
  it('rejects a hostname that merely contains localhost as a subdomain label', () => {
    expect(() => assertFakeAllowed({ CTB_ALLOW_FAKE_DATA: '1' }, 'postgres://ctb:pw@localhost.evil.example:5432/ctb')).toThrow(/localhost database/);
  });
});
