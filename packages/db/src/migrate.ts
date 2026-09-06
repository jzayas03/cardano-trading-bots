import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Sorted migration filenames. Throws if two files share a number: silent shadowing is how schemas drift. */
export async function listMigrations(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const seen = new Map<string, string>();
  for (const f of files) {
    const num = MIGRATION_FILE.exec(f)?.[1] ?? '';
    const prior = seen.get(num);
    if (prior !== undefined) throw new Error(`duplicate migration number ${num}: ${prior} and ${f}`);
    seen.set(num, f);
  }
  return files;
}

/** Applies unapplied migrations in order, each in its own transaction. Returns what it applied. */
export async function migrate(db: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const appliedRows = await db.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.rows.map((r) => r.filename));
  const ran: string[] = [];
  for (const file of await listMigrations(dir)) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}
