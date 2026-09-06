import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listMigrations } from '../src/migrate.js';

async function dirWith(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctb-mig-'));
  for (const f of files) await writeFile(path.join(dir, f), '-- test');
  return dir;
}

describe('listMigrations', () => {
  it('returns matching files sorted by number', async () => {
    const dir = await dirWith(['0002_b.sql', '0001_a.sql', 'README.md', '0003_c.sql.bak']);
    expect(await listMigrations(dir)).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('fails closed on a duplicate number', async () => {
    const dir = await dirWith(['0001_a.sql', '0001_b.sql']);
    await expect(listMigrations(dir)).rejects.toThrow(/duplicate migration number 0001/);
  });
});
