import { describe, expect, it } from 'vitest';
import { effectiveTickIntervalSec, missingTicksCell, type TickCadence } from '../src/cadence.js';

/** The live 2026-09-12 VPS shape: rows every 300 s, a caller holding the 900 s candle interval. */
const live: TickCadence = { ticks: 287, expected: 96, configuredIntervalSec: 900, observedIntervalSec: 300 };

describe('effectiveTickIntervalSec', () => {
  it('is the focus interval when tiered sampling is on, because that is when a row is written', () => {
    expect(effectiveTickIntervalSec({ intervalSec: 900, focusIntervalSec: 300 })).toBe(300);
  });

  it('is the candle interval when tiered sampling is off', () => {
    expect(effectiveTickIntervalSec({ intervalSec: 600, focusIntervalSec: 0 })).toBe(600);
  });
});

describe('missingTicksCell', () => {
  it('prints the count only when the observed cadence corroborates the configured one', () => {
    expect(missingTicksCell({ ticks: 285, expected: 288, configuredIntervalSec: 300, observedIntervalSec: 300 })).toBe('3');
    expect(missingTicksCell({ ticks: 288, expected: 288, configuredIntervalSec: 300, observedIntervalSec: 300 })).toBe('0');
  });

  it('refuses the count on the shape that printed -191, and never prints a negative', () => {
    const cell = missingTicksCell(live);
    expect(cell).toBe('n/a (observed 300s cadence, configured 900s — one of them is wrong)');
    expect(cell).not.toContain('-');
    // The arithmetic the old code did, kept here so the regression is named rather than implied.
    expect(live.expected - live.ticks).toBe(-191);
  });

  it('refuses the count rather than clamping to a reassuring zero', () => {
    // The digest's old `Math.max(expected - ticks, 0)` turned exactly this input into `(0 missing)`.
    expect(missingTicksCell(live)).not.toBe('0');
  });

  it('refuses the count when a cadence cannot be measured, which is also how a dead collector looks', () => {
    expect(missingTicksCell({ ticks: 0, expected: 288, configuredIntervalSec: 300, observedIntervalSec: null }))
      .toBe('n/a (0 ticks in 24h — too few to measure a cadence)');
    expect(missingTicksCell({ ticks: 1, expected: 288, configuredIntervalSec: 300, observedIntervalSec: null }))
      .toBe('n/a (1 tick in 24h — too few to measure a cadence)');
  });

  it('refuses the count when more ticks were recorded than the interval has slots', () => {
    expect(missingTicksCell({ ticks: 300, expected: 288, configuredIntervalSec: 300, observedIntervalSec: 300 }))
      .toBe('n/a (300 ticks exceeds the 288 expected at 300s)');
  });

  it('is n/a when there is no cadence row at all', () => {
    expect(missingTicksCell(null)).toBe('n/a');
  });
});
