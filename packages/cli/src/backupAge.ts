import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Same default the backup command writes to. Kept here rather than imported so `watch` does not
 * pull in the dump machinery just to stat a directory. */
const DEFAULT_DIR = resolve(process.env.HOME ?? '.', 'ctb-backups');

/**
 * Hours since the newest dump was written, or null when there is none.
 *
 * mtime, not the name's timestamp: the question is when a file last ARRIVED, and a restored or
 * copied-in dump is still a real local copy.
 */
export function newestBackupAgeHours(dir = DEFAULT_DIR, now = new Date()): number | null {
  if (!existsSync(dir)) return null;
  const dumps = readdirSync(dir).filter((f) => f.endsWith('.dump'));
  if (dumps.length === 0) return null;
  const newest = Math.max(...dumps.map((f) => statSync(join(dir, f)).mtimeMs));
  return (now.getTime() - newest) / 3_600_000;
}
