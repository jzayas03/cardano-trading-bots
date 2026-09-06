import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Review finding (Task 4, fix round 1): `backfill` and `candles` both write rows FK'd to
 * `tokens(unit)` (`external_pool_map`/`candles_external` and `candles` respectively) without
 * first syncing the universe into `tokens`. On a database where `collect` has never run, that
 * dies with an FK violation. `collect.ts` gets this right — it calls `repo.syncTokens(...)`
 * before touching anything FK'd to `tokens`. This guard pins the same ordering in the other two
 * commands by reading their source: `syncTokens(` must appear before the first use of the
 * FK-writing repo class each command constructs.
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
  it('backfill.ts calls syncTokens before constructing PgExternalRepo', async () => {
    const src = await readCommandSource('backfill.ts');
    const syncAt = indexOfFirst(src, 'syncTokens(');
    const repoAt = indexOfFirst(src, 'new PgExternalRepo(');
    expect(syncAt).toBeLessThan(repoAt);
  });

  it('candles.ts calls syncTokens before constructing PgCandleRepo', async () => {
    const src = await readCommandSource('candles.ts');
    const syncAt = indexOfFirst(src, 'syncTokens(');
    const repoAt = indexOfFirst(src, 'new PgCandleRepo(');
    expect(syncAt).toBeLessThan(repoAt);
  });
});
