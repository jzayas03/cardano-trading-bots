import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/migrate.js';

/**
 * Spec §4.3: locally built candles measure NET reserve flow, not gross volume. A column named
 * `volume` on `candles` would be read as exchange volume by every downstream tool. This guard
 * fails if any migration creates or adds such a column to `candles`.
 */
describe('candles has no volume column (spec §4.3)', () => {
  it('no migration defines a volume column on the candles table', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0002_candles_engine.sql'), 'utf8');
    const candlesDdl = /CREATE TABLE IF NOT EXISTS candles\s*\(([\s\S]*?)\);/m.exec(sql)?.[1];
    expect(candlesDdl, 'candles DDL must exist in 0002').toBeTruthy();
    expect(candlesDdl).toMatch(/net_flow_base\s+numeric\(38,0\)/);
    expect(candlesDdl).toMatch(/net_flow_quote\s+numeric\(38,0\)/);
    // Tokenize by comma/newline rather than anchoring on line start: a `volume` column declared
    // mid-line after another column (e.g. `foo numeric(38,0), volume numeric(38,0),`) has no
    // leading newline for `^` to anchor on, so a line-anchored regex misses it.
    const ddl = candlesDdl ?? '';
    const columnDefs = ddl.split(/[,\n]/).map((s) => s.trim());
    expect(columnDefs.some((s) => /^volume\b/.test(s))).toBe(false);
    expect(columnDefs.some((s) => /^"volume"\b/.test(s))).toBe(false);
    // `ADD COLUMN IF NOT EXISTS volume` and quoted `"volume"` must also be caught, not just the
    // bare `ADD COLUMN volume` shape.
    expect(sql).not.toMatch(/ALTER TABLE\s+candles\s+ADD\s+(COLUMN\s+)?(IF NOT EXISTS\s+)?"?volume"?\b/i);
  });

  it('external candles do carry gross volume, in quote units', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0002_candles_engine.sql'), 'utf8');
    const ext = /CREATE TABLE IF NOT EXISTS candles_external\s*\(([\s\S]*?)\);/m.exec(sql)?.[1];
    expect(ext).toMatch(/volume_quote\s+numeric\(38,6\)/);
  });
});
