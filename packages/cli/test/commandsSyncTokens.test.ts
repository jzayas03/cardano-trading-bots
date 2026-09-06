import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Review finding (Task 4, fix round 1): `backfill` and `candles` both write rows FK'd to
 * `tokens(unit)` (`external_pool_map`/`candles_external` and `candles` respectively) without
 * first syncing the universe into `tokens`. On a database where `collect` has never run, that
 * dies with an FK violation. This guard pins the ordering by reading each command's source: the
 * `ensureTokens(` call must appear before the first use of the FK-writing repo class it constructs.
 *
 * Finding M4: the call and its explanation used to be copy-pasted into all four commands. It now
 * lives in `src/ensureTokens.ts`, so these assertions look for the helper rather than the raw
 * `syncTokens(` — a source-text guard is what this repo uses for wiring that cannot be reached
 * without a database and a Blockfrost key.
 */
async function readCommandSource(file: string): Promise<string> {
  return readFile(path.join(here, '..', 'src', 'commands', file), 'utf8');
}

function indexOfFirst(src: string, needle: string): number {
  const i = src.indexOf(needle);
  expect(i, `expected to find ${JSON.stringify(needle)} in source`).toBeGreaterThanOrEqual(0);
  return i;
}

describe('CLI commands sync the universe into tokens before writing FK-scoped rows', () => {
  it('backfill.ts calls ensureTokens before constructing PgExternalRepo', async () => {
    const src = await readCommandSource('backfill.ts');
    const syncAt = indexOfFirst(src, 'ensureTokens(db');
    const repoAt = indexOfFirst(src, 'new PgExternalRepo(');
    expect(syncAt).toBeLessThan(repoAt);
  });

  it('candles.ts calls ensureTokens before constructing PgCandleRepo', async () => {
    const src = await readCommandSource('candles.ts');
    const syncAt = indexOfFirst(src, 'ensureTokens(db');
    const repoAt = indexOfFirst(src, 'new PgCandleRepo(');
    expect(syncAt).toBeLessThan(repoAt);
  });

  // Task 10: `runs.base_unit` is FK'd to tokens(unit) the same way. backtest.ts must sync the
  // universe in before its first use of PgRunRepo (the run row is the first FK'd write it makes).
  it('backtest.ts calls ensureTokens before constructing PgRunRepo', async () => {
    const src = await readCommandSource('backtest.ts');
    const syncAt = indexOfFirst(src, 'ensureTokens(db');
    const repoAt = indexOfFirst(src, 'new PgRunRepo(');
    expect(syncAt).toBeLessThan(repoAt);
  });

  it('collect.ts uses the same helper, before it constructs the pool source', async () => {
    const src = await readCommandSource('collect.ts');
    expect(indexOfFirst(src, 'ensureTokens(db')).toBeLessThan(indexOfFirst(src, 'new DexterPoolSource('));
  });

  it('every command that writes FK-scoped rows imports the shared helper rather than its own copy', async () => {
    for (const file of ['backfill.ts', 'candles.ts', 'backtest.ts', 'collect.ts']) {
      const src = await readCommandSource(file);
      expect(src, `${file} should call the shared helper`).toContain("from '../ensureTokens.js'");
      expect(src, `${file} should not carry its own syncTokens call`).not.toMatch(/\.syncTokens\(/);
    }
  });
});

/**
 * Finding I7: `DexterPoolSource` accepted a `retryBudgetMs` that no caller ever set, so every run
 * used the built-in 60 s default — which can outlast a 60 s collector interval entirely. The bound
 * has to be derived from the configured interval, and the only place that knows it is `collect`.
 */
describe('collect wires the retry budget to the configured interval', () => {
  it('passes retryBudgetMs derived from cfg.intervalSec to DexterPoolSource', async () => {
    const src = await readCommandSource('collect.ts');
    expect(src).toMatch(/new DexterPoolSource\(\{[^}]*retryBudgetMs:\s*cfg\.intervalSec \* 500/);
  });
});
