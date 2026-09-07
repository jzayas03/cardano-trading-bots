/**
 * The SELECT-only queries the existing repos don't already provide (spec §4.3). Task 4 declares the
 * shape only — `DashboardDeps.reads` is typed against this interface so the router can be written and
 * tested now with a literal `{ listRuns: async () => [] }`. Task 5 adds `PgDashboardReads`, the
 * concrete class backing it (and, per spec §4.3, the rest of this interface: `latestSnapshotsPerToken`,
 * `snapshotAt`, `externalCoverageAll`, `runsSharingGrid`), in this same file.
 */
import type { RunRow } from '@ctb/engine';

export interface RunFilter {
  mode?: 'backtest' | 'paper';
  strategyId?: string;
  ticker?: string;
  status?: 'running' | 'finished' | 'aborted';
}

export interface DashboardReads {
  /** Newest first, per spec §3 ("nothing is sorted by return"); `limit`/`offset` bound every call. */
  listRuns(filter: RunFilter, limit: number, offset: number): Promise<RunRow[]>;
}
