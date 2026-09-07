/**
 * The SELECT-only queries the existing repos don't already provide (spec §4.3). `PgDashboardReads`
 * is the concrete read-only class backing `DashboardDeps.reads`; Task 4 wired the interface with a
 * literal `{ listRuns: async () => [] }` stub so the router could be built and tested before this
 * landed. Spec §4.3 also names `latestSnapshotsPerToken`, `snapshotAt`, `externalCoverageAll` and
 * `runsSharingGrid` for a later page; Task 5's brief scopes this file to `listRuns` only (the runs
 * list and detail pages need nothing else), so those four are left for whichever task adds the page
 * that needs them.
 */
import type { Queryable } from '@ctb/db';
import { rowToRun, type RunRow, type RunsRowRaw } from '@ctb/engine';

/** The enum values `mode`/`status` accept, exported so the router (query-string validation) and
 * `pages/runs.ts` (the filter form's `<select>` options) read from one place instead of each
 * hard-coding its own copy that can drift from the other. */
export const RUN_MODES = ['backtest', 'paper'] as const;
export const RUN_STATUSES = ['running', 'finished', 'aborted'] as const;

export interface RunFilter {
  mode?: (typeof RUN_MODES)[number];
  /** `runs.strategy_id`. Freeform: no fixed enum exists (a strategy can be added without a migration). */
  strategy?: string;
  /** `runs.base_unit` — the raw asset unit, not a ticker. The router resolves a `?ticker=` query
   * value to a unit (via the universe) before it ever reaches this filter; this package has no
   * notion of tickers itself. */
  unit?: string;
  status?: (typeof RUN_STATUSES)[number];
}

export interface DashboardReads {
  /** Newest first, per spec §3 ("nothing is sorted by return"); `limit`/`offset` bound every call. */
  listRuns(filter: RunFilter, limit: number, offset: number): Promise<RunRow[]>;
}

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

export class PgDashboardReads implements DashboardReads {
  constructor(private readonly q: Queryable) {}

  /**
   * WHERE clauses are added only for the filter keys actually present, each its own parameter —
   * never string-interpolated. `limit` is clamped to [1, 500] so a caller (or a malformed `?page=`
   * upstream) can never turn this into an unbounded scan (spec §3, "always bounded").
   */
  async listRuns(filter: RunFilter, limit: number, offset: number): Promise<RunRow[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    const addClause = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      values.push(value);
      clauses.push(`${column} = $${values.length}`);
    };
    addClause('mode', filter.mode);
    addClause('strategy_id', filter.strategy);
    addClause('base_unit', filter.unit);
    addClause('status', filter.status);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const clampedLimit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    values.push(clampedLimit);
    const limitParam = `$${values.length}`;
    values.push(safeOffset);
    const offsetParam = `$${values.length}`;

    const res = await this.q.query<RunsRowRaw>(
      `SELECT * FROM runs ${where} ORDER BY id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`, values);
    return res.rows.map(rowToRun);
  }
}
