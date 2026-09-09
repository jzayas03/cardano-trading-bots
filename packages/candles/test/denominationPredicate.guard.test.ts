import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every SQL statement touching `candles_external` must say which denomination it means.
 *
 * The table now holds both USD and ADA rows for the same token, tick and pool. A read that omits the
 * predicate returns both, interleaved by timestamp, and produces a price series that alternates
 * between two currencies — a silently wrong backtest, not an error. That is the same shape as the
 * bug this whole change exists to fix, so it gets a ratchet rather than a comment.
 */
const SRC = readFileSync(fileURLToPath(new URL('../src/externalRepo.ts', import.meta.url)), 'utf8');

/** Statements are found by the table name, then checked for the predicate. */
function statementsTouchingExternal(src: string): string[] {
  return src
    .split('`')
    // The table name also appears in prose. A chunk only counts as SQL when it carries a verb, or
    // this guard fails on its own explanatory comments — which would train someone to weaken it.
    .filter((chunk) => /\bcandles_external\b/.test(chunk) && /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(chunk));
}

describe('every candles_external statement is denomination-scoped', () => {
  it('finds the statements at all', () => {
    // An empty corpus would pass the assertions below forever.
    expect(statementsTouchingExternal(SRC).length).toBeGreaterThanOrEqual(3);
  });

  it('each one names the denomination', () => {
    for (const stmt of statementsTouchingExternal(SRC)) {
      const first = stmt.trim().split('\n')[0]!.trim();
      expect(/denomination/.test(stmt), `statement starting "${first}" does not mention denomination`).toBe(true);
    }
  });

  it('CONTROL: prose mentioning the table is not treated as a statement', () => {
    expect(statementsTouchingExternal('/** see `candles_external` for the history */')).toEqual([]);
  });

  it('CONTROL: the detector fails a statement that omits it', () => {
    // Without this, a detector that matched nothing would pass the test above forever.
    const bad = 'const q = `SELECT close FROM candles_external WHERE base_unit = $1`;';
    const found = statementsTouchingExternal(bad);
    expect(found).toHaveLength(1);
    expect(/denomination/.test(found[0]!)).toBe(false);
  });

  it('CONTROL: and passes one that includes it', () => {
    const good = 'const q = `SELECT close FROM candles_external WHERE base_unit = $1 AND denomination = $2`;';
    expect(/denomination/.test(statementsTouchingExternal(good)[0]!)).toBe(true);
  });
});
