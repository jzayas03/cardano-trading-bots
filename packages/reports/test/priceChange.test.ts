import { describe, expect, it } from 'vitest';
import { dayAgo, priceChangePct } from '../src/index.js';

describe('dayAgo', () => {
  it('is exactly 24 hours (86_400_000 ms) before `now`', () => {
    const now = new Date('2026-09-07T19:10:00.000Z');
    expect(dayAgo(now).toISOString()).toBe('2026-09-06T19:10:00.000Z');
    expect(now.getTime() - dayAgo(now).getTime()).toBe(86_400_000);
  });

  it('crosses a day/month/year boundary correctly, not just a fixed offset in the same day', () => {
    expect(dayAgo(new Date('2026-01-01T00:30:00.000Z')).toISOString()).toBe('2025-12-31T00:30:00.000Z');
  });

  it('does not mutate its argument', () => {
    const now = new Date('2026-09-07T19:10:00.000Z');
    const before = now.getTime();
    dayAgo(now);
    expect(now.getTime()).toBe(before);
  });
});

describe('priceChangePct', () => {
  it('a doubling is 100', () => {
    expect(priceChangePct('1.000000000000000000', '2.000000000000000000')).toBe(100);
  });

  it('a halving is -50', () => {
    expect(priceChangePct('2.000000000000000000', '1.000000000000000000')).toBe(-50);
  });

  it('equal prices are 0 — not null; unchanged is a known fact, not an absence', () => {
    expect(priceChangePct('0.500000000000000000', '0.500000000000000000')).toBe(0);
  });

  it('a zero `then` is null — there is no percentage of nothing', () => {
    expect(priceChangePct('0', '1.000000000000000000')).toBeNull();
    expect(priceChangePct('0.000000000000000000', '1.000000000000000000')).toBeNull();
  });

  it('an empty, absent or unparseable `then` is null', () => {
    expect(priceChangePct('', '1')).toBeNull();
    expect(priceChangePct(null, '1')).toBeNull();
    expect(priceChangePct(undefined, '1')).toBeNull();
    expect(priceChangePct('not-a-number', '1')).toBeNull();
  });

  it('an absent or unparseable `now` is also null', () => {
    expect(priceChangePct('1', null)).toBeNull();
    expect(priceChangePct('1', undefined)).toBeNull();
    expect(priceChangePct('1', 'not-a-number')).toBeNull();
  });

  // Asymmetric on purpose, matching the function's own guard: `then` gets an explicit `a === 0` check
  // (there is no percentage OF nothing — the baseline itself can't be zero), but `now` has no matching
  // `b === 0` guard, so an empty string `now` is simply `Number('') === 0` — a real, if unusual,
  // computed figure (a price that went to exactly zero), not a guarded absence like `then` gets.
  it('an empty string `now` is Number("") === 0 — a real figure, unlike an empty `then`', () => {
    expect(priceChangePct('1', '')).toBe(-100);
  });

  it('a very small decimal string still yields a finite number', () => {
    const pct = priceChangePct('0.000000000000000001', '0.000000000000000002');
    expect(pct).toBe(100);
  });

  it('rounds to two decimal places', () => {
    // (1.1 - 1) / 1 * 100 = 10.000000000000009 in floating point — must round to 10, not carry noise.
    expect(priceChangePct('1', '1.1')).toBe(10);
    // (1 - 3) / 3 * 100 = -66.66666...; rounds to -66.67, not truncates to -66.66.
    expect(priceChangePct('3', '1')).toBe(-66.67);
  });
});
