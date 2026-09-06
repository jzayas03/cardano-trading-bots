import { PgSnapshotRepo } from '@ctb/collector';
import type { Db } from '@ctb/db';
import type { Universe } from '@ctb/universe';

/**
 * `candles`, `candles_external`, `external_pool_map` and `runs` are all FK'd to `tokens(unit)`, so
 * any command that writes one of them has to mirror the universe into `tokens` first or die with an
 * FK violation on a database where `collect` has never run.
 *
 * Four commands each carried their own copy of this call and their own paragraph explaining it
 * (finding M4). One helper, one explanation, and a fifth command cannot forget it by copying the
 * wrong neighbour — `commandsSyncTokens.test.ts` pins that every command calls it before it
 * constructs the repo that does the FK'd write.
 */
export async function ensureTokens(db: Db, universe: Universe): Promise<void> {
  await new PgSnapshotRepo(db).syncTokens(universe.tokens, { seededAt: universe.seededAt, seedSource: universe.seedSource });
}
