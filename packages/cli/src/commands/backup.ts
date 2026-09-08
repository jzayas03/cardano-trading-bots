import { execFile, execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPool } from '@ctb/db';
import type { Logger } from 'pino';
import { loadConfig } from '../config.js';
import { objectKey, R2Store, readR2Setting, R2_VARS } from '../r2.js';
import {
  assertDroppable, compareCounts, dumpFileName, manifestFileName, newestDump, pruneOldDumps,
  verifyDbName, type Manifest, type TableCount,
} from '../backup.js';

/** Where dumps land unless `--dir` says otherwise. Deliberately outside the repo: a backup inside
 * the working tree is one `git clean -fdx` from gone, and would also be a candidate for commit. */
const DEFAULT_DIR = resolve(process.env.HOME ?? '.', 'ctb-backups');
const DEFAULT_KEEP = 14;
/** The Postgres runs in Docker (docker-compose.yml). Using the CONTAINER's pg_dump rather than the
 * host's keeps client and server on the same version — this Mac's Homebrew pg_dump is 18.x against
 * a 16.x server, which works but is a version skew nobody needs in a recovery path. */
const DEFAULT_CONTAINER = 'ctb_postgres';

function arg(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null; // intentional: a dump taken outside a git checkout is still a valid dump
  }
}

/** Every base table in `public`, so the manifest describes the whole database rather than a list
 * someone remembered to update when they added a table. */
async function tableNames(q: { query: (t: string) => Promise<{ rows: Array<Record<string, unknown>> }> }): Promise<string[]> {
  const r = await q.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  return r.rows.map((row) => String(row.tablename));
}

/**
 * Dump the database, and record row counts taken INSIDE the dump's own snapshot.
 *
 * This is the whole point of the command. A count taken on a second connection — even one second
 * later — measures the interval between the two, not the copy: the collector writes every boundary
 * and three paper runs write at every fill. So the sequence is:
 *
 *   1. open a transaction at REPEATABLE READ and export its snapshot
 *   2. hand that snapshot id to `pg_dump --snapshot`, so the dump sees exactly this instant
 *   3. count rows in the SAME transaction, so the counts describe the same instant
 *   4. only then commit
 *
 * Without step 2 the manifest is a plausible-looking number that verifies nothing.
 */
export async function backupCommand(log: Logger, args: readonly string[]): Promise<void> {
  const cfg = loadConfig(process.env, { blockfrost: false });
  const dir = arg(args, '--dir') ?? DEFAULT_DIR;
  const keep = Number(arg(args, '--keep') ?? DEFAULT_KEEP);
  const container = arg(args, '--container') ?? DEFAULT_CONTAINER;
  if (!Number.isFinite(keep) || keep < 1) throw new Error(`--keep must be a positive integer, got ${arg(args, '--keep')}`);
  mkdirSync(dir, { recursive: true });

  const url = new URL(cfg.databaseUrl);
  const dbName = url.pathname.slice(1);
  const dbUser = decodeURIComponent(url.username);

  // A pool with no 'error' listener turns a dropped backend into a process-level crash rather than
  // a logged error, and this command holds a transaction open for the length of a dump.
  const pool = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'backup pool error'));
  const client = await pool.connect();
  const now = new Date();
  const file = dumpFileName(now);
  const path = join(dir, file);
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const snap = await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id');
    const snapshotId = snap.rows[0]?.id;
    if (!snapshotId) throw new Error('pg_export_snapshot() returned nothing');
    const ver = await client.query<{ v: string }>('SHOW server_version');

    log.info({ snapshotId, path }, 'dumping at an exported snapshot');
    await new Promise<void>((ok, fail) => {
      const out = createWriteStream(path);
      const child = execFile('docker', [
        'exec', '-i', container,
        'pg_dump', '-U', dbUser, '-d', dbName, '--format=custom', '--no-owner', `--snapshot=${snapshotId}`,
      ], { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' });
      let stderr = '';
      child.stderr?.on('data', (b: Buffer) => { stderr += b.toString(); });
      child.stdout?.pipe(out);
      child.on('error', fail);
      child.on('close', (code) => {
        out.end();
        // A non-zero pg_dump that has already written bytes is the dangerous case: the file exists
        // and looks like a backup. Fail loudly and leave nothing behind that could be restored.
        if (code !== 0) { try { rmSync(path); } catch { /* intentional: nothing to clean up */ } fail(new Error(`pg_dump exited ${code}: ${stderr.trim()}`)); }
        else ok();
      });
    });

    // Counts, in the SAME transaction and therefore the same snapshot the dump just read.
    const counts: TableCount[] = [];
    for (const t of await tableNames(client)) {
      const c = await client.query<{ n: string }>(`SELECT count(*) AS n FROM "${t}"`);
      counts.push({ table: t, rows: Number(c.rows[0]?.n ?? 0) });
    }
    await client.query('COMMIT');

    const manifest: Manifest = {
      createdAt: now.toISOString(), dumpFile: file, snapshotId,
      serverVersion: ver.rows[0]?.v ?? 'unknown', gitSha: gitSha(),
      bytes: statSync(path).size, counts,
    };
    writeFileSync(join(dir, manifestFileName(file)), `${JSON.stringify(manifest, null, 2)}\n`);

    // Off-machine copy. A same-disk backup survives a bad migration and a wrong DROP; it does not
    // survive the disk. Partial R2 config throws rather than silently staying local — believing you
    // have off-site backups when you do not is worse than knowing you have none.
    const r2 = readR2Setting(process.env);
    if (r2.kind === 'partial') {
      throw new Error(`R2 is half-configured: ${r2.missing.join(', ')} missing. Set all of ${R2_VARS.join(', ')} or none.`);
    }
    if (r2.kind === 'configured') {
      const store = new R2Store(r2.config);
      const manifestJson = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      await store.put(objectKey(file), readFileSync(path));
      await store.put(objectKey(manifestFileName(file)), manifestJson, 'application/json');
      log.info({ bucket: r2.config.bucket, key: objectKey(file) }, 'uploaded to R2');
      console.log(`        uploaded to r2://${r2.config.bucket}/${objectKey(file)}`);
      // Retention applies to the remote too, or the bucket grows forever while the local directory
      // stays trimmed and nobody notices until a bill arrives.
      const remote = await store.list();
      const remoteDumps = remote.filter((k) => k.endsWith('.dump')).map((k) => k.replace(/^ctb\//, ''));
      for (const f of pruneOldDumps(remoteDumps, keep)) {
        await store.delete(objectKey(f));
        await store.delete(objectKey(manifestFileName(f)));
      }
    }

    const removed = pruneOldDumps(readdirSync(dir), keep);
    for (const f of removed) {
      rmSync(join(dir, f), { force: true });
      rmSync(join(dir, manifestFileName(f)), { force: true });
    }

    const total = counts.reduce((s, c) => s + c.rows, 0);
    log.info({ path, mb: +(manifest.bytes / 1048576).toFixed(1), tables: counts.length, rows: total, pruned: removed.length }, 'backup written');
    console.log(`backup: ${path}`);
    console.log(`        ${(manifest.bytes / 1048576).toFixed(1)} MB, ${counts.length} tables, ${total} rows, snapshot ${snapshotId}`);
    console.log(`        verify it with: npm run backup:verify`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { /* intentional: the transaction is already gone */ });
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Restore the newest dump into a scratch database and compare its row counts against the manifest.
 *
 * A backup job that runs is not a backup. This is the command that turns "we take dumps" into
 * "we have restored one", and it is the only thing that can catch a dump that is truncated,
 * corrupt, written by a pg_dump that failed after producing bytes, or restorable only into a
 * server we no longer run.
 *
 * The comparison is against the MANIFEST, never against the live database — the live database has
 * moved on by every boundary since, and comparing to it would report drift as corruption.
 */
export async function backupVerifyCommand(log: Logger, argv: readonly string[]): Promise<void> {
  let args: readonly string[] = argv;
  const cfg = loadConfig(process.env, { blockfrost: false });
  const dir = arg(args, '--dir') ?? DEFAULT_DIR;
  const container = arg(args, '--container') ?? DEFAULT_CONTAINER;
  if (!existsSync(dir)) throw new Error(`no backup directory at ${dir}; run \`npm run backup\` first`);

  // --remote verifies the copy that would actually be used in a disaster: the one in R2, pulled
  // back down. A verify that only ever reads the local file proves the local file, which is the
  // copy least likely to be there when it matters.
  if (args.includes('--remote')) {
    const r2 = readR2Setting(process.env);
    if (r2.kind !== 'configured') {
      throw new Error(r2.kind === 'absent'
        ? `--remote needs R2 configured: set ${R2_VARS.join(', ')}`
        : `R2 is half-configured: ${r2.missing.join(', ')} missing`);
    }
    const store = new R2Store(r2.config);
    const keys = await store.list();
    const newestKey = keys.filter((k) => k.endsWith('.dump')).sort().at(-1);
    if (!newestKey) throw new Error(`no .dump objects under ctb/ in r2://${r2.config.bucket}`);
    const name = newestKey.replace(/^ctb\//, '');
    mkdirSync(dir, { recursive: true });
    log.info({ bucket: r2.config.bucket, key: newestKey }, 'downloading from R2 to verify the remote copy');
    writeFileSync(join(dir, name), await store.get(newestKey));
    writeFileSync(join(dir, manifestFileName(name)), await store.get(objectKey(manifestFileName(name))));
    console.log(`downloaded r2://${r2.config.bucket}/${newestKey}`);
    args = [...args.filter((a) => a !== '--remote'), '--file', name];
  }

  const chosen = arg(args, '--file') ?? newestDump(readdirSync(dir));
  if (!chosen) throw new Error(`no .dump files in ${dir}; run \`npm run backup\` first`);
  const manifestPath = join(dir, manifestFileName(chosen));
  if (!existsSync(manifestPath)) throw new Error(`${chosen} has no manifest beside it; it cannot be verified`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

  const url = new URL(cfg.databaseUrl);
  const dbUser = decodeURIComponent(url.username);
  const scratch = verifyDbName(new Date());

  const pool = createPool(cfg.databaseUrl, (err) => log.error({ err: err.message }, 'verify pool error'));
  let created = false;
  try {
    log.info({ dump: chosen, scratch }, 'restoring into a scratch database');
    await pool.query(`CREATE DATABASE "${scratch}"`);
    created = true;

    await new Promise<void>((ok, fail) => {
      const child = execFile('docker', [
        'exec', '-i', container, 'pg_restore', '-U', dbUser, '-d', scratch, '--no-owner', '--exit-on-error',
      ], { maxBuffer: 1024 * 1024 * 1024 });
      let stderr = '';
      child.stderr?.on('data', (b: Buffer) => { stderr += b.toString(); });
      child.on('error', fail);
      child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`pg_restore exited ${code}: ${stderr.trim()}`))));
      if (child.stdin) createReadStream(join(dir, chosen)).pipe(child.stdin);
    });

    const scratchUrl = new URL(cfg.databaseUrl);
    scratchUrl.pathname = `/${scratch}`;
    const rpool = createPool(scratchUrl.toString(), (err) => log.error({ err: err.message }, 'scratch pool error'));
    const actual: TableCount[] = [];
    try {
      for (const t of await tableNames(rpool)) {
        const c = await rpool.query<{ n: string }>(`SELECT count(*) AS n FROM "${t}"`);
        actual.push({ table: t, rows: Number(c.rows[0]?.n ?? 0) });
      }
    } finally {
      await rpool.end();
    }

    const diffs = compareCounts(manifest.counts, actual);
    const rows = actual.reduce((s, c) => s + c.rows, 0);
    if (diffs.length > 0) {
      for (const d of diffs) log.error({ table: d.table, expected: d.expected, actual: d.actual }, 'restored count does not match the manifest');
      console.log(`VERIFY FAILED: ${diffs.length} table(s) differ from ${chosen}`);
      for (const d of diffs) console.log(`  ${d.table}: manifest ${d.expected}, restored ${d.actual}`);
      throw new Error(`backup ${chosen} did not verify`);
    }
    console.log(`verified: ${chosen}`);
    console.log(`          ${actual.length} tables, ${rows} rows, all matching the manifest taken at snapshot ${manifest.snapshotId}`);
  } finally {
    if (created) {
      // The prefix check is the guard between a bug in verifyDbName and someone's real database.
      assertDroppable(scratch);
      await pool.query(`DROP DATABASE IF EXISTS "${scratch}"`).catch((e: Error) => log.error({ err: e.message, scratch }, 'could not drop the scratch database'));
    }
    await pool.end();
  }
}
