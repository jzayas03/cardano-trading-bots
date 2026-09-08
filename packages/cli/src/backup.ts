/**
 * Pure helpers for `backup` and `backup:verify`.
 *
 * The impure orchestration lives in `commands/backup.ts`; everything here is a function of its
 * arguments so the naming, retention and comparison rules can be tested without a database, a
 * filesystem, or a `pg_dump` binary.
 */

/** One table's row count, captured inside the dump's own transaction snapshot. */
export type TableCount = { table: string; rows: number };

/**
 * What a dump is accompanied by. Written beside the dump file, and read back by `backup:verify`.
 *
 * `snapshotId` is recorded for provenance: it is the `pg_export_snapshot()` id that `pg_dump`
 * imported, which is what makes `counts` a description of the COPY rather than of the database at
 * some nearby moment. Without it a reader cannot tell whether the counts were taken honestly.
 */
export type Manifest = {
  createdAt: string;
  dumpFile: string;
  snapshotId: string;
  serverVersion: string;
  gitSha: string | null;
  bytes: number;
  counts: TableCount[];
};

/**
 * A dump's file name. Sorts chronologically as a string, which is what makes `newestDump` and
 * `pruneOldDumps` able to work on names alone rather than on filesystem timestamps — an mtime is
 * rewritten by a copy or a restore from Time Machine, and would silently reorder the set.
 */
export function dumpFileName(now: Date): string {
  return `ctb-${now.toISOString().replace(/[:.]/g, '-')}.dump`;
}

/** The manifest that belongs to a dump file. One rule, so neither side has to guess. */
export function manifestFileName(dumpFile: string): string {
  return `${dumpFile}.manifest.json`;
}

/** Newest by name, which is newest by time because `dumpFileName` is ISO-ordered. */
export function newestDump(files: readonly string[]): string | undefined {
  return files.filter((f) => f.endsWith('.dump')).sort().at(-1);
}

/**
 * Which dumps to delete, keeping the `keep` newest.
 *
 * Returns the files to REMOVE rather than the ones to keep, so a caller cannot accidentally invert
 * the sense of it — a retention bug that deletes the wrong side is unrecoverable, and the shape of
 * the return value is the cheapest guard available against writing it backwards.
 */
export function pruneOldDumps(files: readonly string[], keep: number): string[] {
  if (keep < 1) throw new Error(`keep must be at least 1, got ${keep}`);
  const dumps = files.filter((f) => f.endsWith('.dump')).sort();
  return dumps.slice(0, Math.max(0, dumps.length - keep));
}

/** One table whose restored count did not match the manifest. */
export type CountMismatch = { table: string; expected: number; actual: number | 'missing' };

/**
 * Compares a restored database's counts against the manifest's.
 *
 * A table present in the manifest and absent from the restore is a mismatch, not a skip: that is
 * exactly what a truncated or partially-restored dump looks like, and it is the failure this whole
 * command exists to catch. A table present in the restore but NOT in the manifest is also reported,
 * because it means the two are not describing the same schema.
 */
export function compareCounts(expected: readonly TableCount[], actual: readonly TableCount[]): CountMismatch[] {
  const actualByTable = new Map(actual.map((c) => [c.table, c.rows]));
  const out: CountMismatch[] = [];
  for (const e of expected) {
    const a = actualByTable.get(e.table);
    if (a === undefined) out.push({ table: e.table, expected: e.rows, actual: 'missing' });
    else if (a !== e.rows) out.push({ table: e.table, expected: e.rows, actual: a });
  }
  const expectedTables = new Set(expected.map((c) => c.table));
  for (const a of actual) {
    if (!expectedTables.has(a.table)) out.push({ table: a.table, expected: 0, actual: a.rows });
  }
  return out.sort((x, y) => x.table.localeCompare(y.table));
}

/**
 * The name of the scratch database a verify restores into.
 *
 * Always prefixed `ctb_verify_`, so the drop at the end of a verify can refuse to touch anything
 * that does not carry the prefix. The verify drops a database; the prefix is the thing standing
 * between a bug here and someone's real one.
 */
export function verifyDbName(now: Date): string {
  return `ctb_verify_${now.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
}

/** Refuses any database name a verify has no business dropping. Called immediately before the DROP. */
export function assertDroppable(name: string): void {
  if (!/^ctb_verify_[0-9]{14}$/.test(name)) {
    throw new Error(`refusing to drop ${name}: a verify may only drop its own ctb_verify_* scratch database`);
  }
}
