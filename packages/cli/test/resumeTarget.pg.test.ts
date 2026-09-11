import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate } from '@ctb/db';
import { describe, expect, it } from 'vitest';
import { PG_ENABLED, withTestSchema } from '../../db/test/helpers.js';

/**
 * `infra/vps/resume-target.sql`, against a real schema — the query a restarting paper unit uses to
 * decide whether it is continuing a run or starting a new one.
 *
 * It is read from the FILE the script runs, not retyped here. A copy would drift, and this is the
 * query whose old version forked run 146 into 149 on 2026-09-11 while resuming 147 and 148 from the
 * same restart.
 */
const SQL_PATH = resolve(import.meta.dirname, '../../../infra/vps/resume-target.sql');

/**
 * The one seam between the two callers: the script binds psql variables, node-postgres binds `$n`.
 * The WHERE clause — the part that can be wrong — is shared verbatim. The substitution asserts the
 * variable names it expects, so renaming one in the .sql fails here instead of silently matching
 * nothing.
 */
function sqlForPg(): string {
  const raw = readFileSync(SQL_PATH, 'utf8');
  for (const v of [":'strategy'", ":'ticker'", ':window_seconds']) {
    expect(raw, `${SQL_PATH} no longer binds ${v}`).toContain(v);
  }
  // Comments are stripped FIRST, and then every occurrence is replaced. The first attempt did
  // neither: `.replace` swaps only the first match, and the first `:window_seconds` in the file is
  // inside the comment EXPLAINING it — so the real one in the WHERE clause survived untouched and
  // Postgres rejected the bare `:`. The header is free to name its own variables.
  const body = raw.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  return body.replaceAll(":'strategy'", '$1').replaceAll(":'ticker'", '$2').replaceAll(':window_seconds', '$3');
}

const P = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const UNIT = `${P}534e454b`;
const OTHER_UNIT = `${P}4e49474854`;

type Row = { id: number; status: string };

async function seed(db: Parameters<Parameters<typeof withTestSchema>[0]>[0]): Promise<void> {
  await migrate(db);
  await db.query(`INSERT INTO tokens VALUES ($1, $2, '534e454b', 'SNEK', 0, 'Meme', '2026-09-05', 'test')`, [UNIT, P]);
  await db.query(`INSERT INTO tokens VALUES ($1, $2, '4e49474854', 'NIGHT', 6, 'Privacy', '2026-09-05', 'test')`, [OTHER_UNIT, P]);
}

/** A paper run in a chosen terminal state, finished `agoSeconds` ago. */
async function makeRun(
  db: Parameters<Parameters<typeof withTestSchema>[0]>[0],
  o: { strategy?: string; unit?: string; status: string; stopReason?: string | null; agoSeconds?: number },
): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO runs (mode, strategy_id, base_unit, data_source, data_from, data_to, fill_model, params, git_sha, status, stop_reason, finished_at)
     VALUES ('paper', $1, $2, 'candles', now(), now(), 'cpmm_observed', '{}'::jsonb, 'sha', $3, $4,
             CASE WHEN $3 = 'running' THEN NULL ELSE now() - make_interval(secs => $5::int) END)
     RETURNING id`,
    [o.strategy ?? 'ma-crossover', o.unit ?? UNIT, o.status, o.stopReason ?? null, o.agoSeconds ?? 0],
  );
  return r.rows[0]!.id;
}

const target = async (
  db: Parameters<Parameters<typeof withTestSchema>[0]>[0],
  ticker = 'SNEK', windowSeconds = 120, strategy = 'ma-crossover',
): Promise<Row | null> => {
  const r = await db.query<Row>(sqlForPg(), [strategy, ticker, windowSeconds]);
  return r.rows[0] ?? null;
};

describe.skipIf(!PG_ENABLED)('which run a restarting paper unit takes over', () => {
  it('resumes a row still marked running, as it always did', async () => {
    await withTestSchema(async (db) => {
      await seed(db);
      const id = await makeRun(db, { status: 'running' });
      expect(await target(db)).toMatchObject({ id, status: 'running' });
    });
  });

  it('RESUMES a run signalled seconds ago — the fork this closes', async () => {
    // 2026-09-11 06:16: run 146 wrote `finished`/`signal` within 5s of SIGINT and the restart, seeing
    // no `running` row, forked it into a new run. The old query returned nothing here.
    await withTestSchema(async (db) => {
      await seed(db);
      const id = await makeRun(db, { status: 'finished', stopReason: 'signal', agoSeconds: 5 });
      expect(await target(db)).toMatchObject({ id, status: 'finished' });
    });
  });

  it('leaves a run signalled long ago alone — that was a deliberate stop, not a restart', async () => {
    await withTestSchema(async (db) => {
      await seed(db);
      await makeRun(db, { status: 'finished', stopReason: 'signal', agoSeconds: 600 });
      expect(await target(db)).toBeNull();
    });
  });

  it('will not take over a run that stopped for any reason OTHER than a signal', async () => {
    // Something went wrong; a human should look before it silently continues.
    await withTestSchema(async (db) => {
      await seed(db);
      await makeRun(db, { status: 'finished', stopReason: 'feed failure', agoSeconds: 5 });
      expect(await target(db)).toBeNull();
      await makeRun(db, { status: 'aborted', stopReason: 'signal', agoSeconds: 5 });
      expect(await target(db)).toBeNull();
    });
  });

  it('never crosses tokens or strategies', async () => {
    await withTestSchema(async (db) => {
      await seed(db);
      await makeRun(db, { status: 'running', unit: OTHER_UNIT });
      expect(await target(db, 'SNEK')).toBeNull();
      await makeRun(db, { status: 'running', strategy: 'rsi-mean-reversion' });
      expect(await target(db, 'SNEK', 120, 'ma-crossover')).toBeNull();
    });
  });

  it('prefers the newest candidate when a stopped run and a live one both qualify', async () => {
    await withTestSchema(async (db) => {
      await seed(db);
      await makeRun(db, { status: 'finished', stopReason: 'signal', agoSeconds: 5 });
      const newer = await makeRun(db, { status: 'running' });
      expect(await target(db)).toMatchObject({ id: newer });
    });
  });

  it('honours the window it is given, so the restart tolerance is a decision and not a constant', async () => {
    await withTestSchema(async (db) => {
      await seed(db);
      const id = await makeRun(db, { status: 'finished', stopReason: 'signal', agoSeconds: 300 });
      expect(await target(db, 'SNEK', 120)).toBeNull();
      expect(await target(db, 'SNEK', 600)).toMatchObject({ id });
    });
  });
});
