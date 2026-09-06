import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/migrate.js';

/**
 * Spec §4.3: locally built candles measure NET reserve flow, not gross volume. A column named
 * `volume` on `candles` would be read as exchange volume by every downstream tool.
 *
 * Finding I4: this guard used to read `0002_candles_engine.sql` and nothing else, so it protected
 * exactly one file and would have said nothing about the `ALTER TABLE candles ADD COLUMN volume` that
 * a later migration is the only plausible way to introduce it. It now reads EVERY migration, and
 * asserts a floor on how many it found — a glob that silently matches nothing is the classic way a
 * guard passes green while checking nothing.
 */
async function migrationFiles(): Promise<Array<{ file: string; sql: string }>> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(names.map(async (file) => ({ file, sql: await readFile(path.join(MIGRATIONS_DIR, file), 'utf8') })));
}

/** Column definitions of a CREATE TABLE body, split on commas and newlines so a mid-line column is still seen. */
function columnDefs(ddl: string): string[] {
  return ddl.split(/[,\n]/).map((s) => s.trim());
}

describe('candles has no volume column (spec §4.3)', () => {
  it('reads every migration, not just the one that created the table', async () => {
    const files = await migrationFiles();
    expect(files.length, 'the glob must actually be finding the migrations').toBeGreaterThanOrEqual(3);
    expect(files.map((f) => f.file)).toContain('0002_candles_engine.sql');
  });

  it('no migration defines or adds a volume column on the candles table', async () => {
    for (const { file, sql } of await migrationFiles()) {
      // Every CREATE TABLE ... candles ( ... ) in this file, whichever migration wrote it.
      for (const create of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?candles\s*\(([\s\S]*?)\);/gm)) {
        const defs = columnDefs(create[1] ?? '');
        expect(defs.some((s) => /^volume\b/.test(s)), `${file}: candles must not declare a volume column`).toBe(false);
        expect(defs.some((s) => /^"volume"(?=\s|,|$)/.test(s)), `${file}: candles must not declare a quoted "volume" column`).toBe(false);
      }
      // `ADD COLUMN IF NOT EXISTS volume` and quoted `"volume"` must be caught too, not just `ADD COLUMN volume`.
      expect(sql, `${file}: candles must not gain a volume column by ALTER`)
        .not.toMatch(/ALTER TABLE\s+candles\s+ADD\s+(COLUMN\s+)?(IF NOT EXISTS\s+)?"?volume"?\b/i);
    }
  });

  it('0002 still declares the net-flow columns the candle builder writes', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0002_candles_engine.sql'), 'utf8');
    const candlesDdl = /CREATE TABLE IF NOT EXISTS candles\s*\(([\s\S]*?)\);/m.exec(sql)?.[1];
    expect(candlesDdl, 'candles DDL must exist in 0002').toBeTruthy();
    expect(candlesDdl).toMatch(/net_flow_base\s+numeric\(38,0\)/);
    expect(candlesDdl).toMatch(/net_flow_quote\s+numeric\(38,0\)/);
  });

  it('external candles do carry gross volume, in quote units', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0002_candles_engine.sql'), 'utf8');
    const ext = /CREATE TABLE IF NOT EXISTS candles_external\s*\(([\s\S]*?)\);/m.exec(sql)?.[1];
    expect(ext).toMatch(/volume_quote\s+numeric\(38,6\)/);
  });
});
