-- Paper mode (Plan 3). A 7-day run cannot hold its equity curve in memory and write it at the end
-- (final review I6): every point is persisted as it happens, and the run row carries liveness.
CREATE TABLE IF NOT EXISTS run_equity (
  run_id                     bigint NOT NULL REFERENCES runs(id),
  tick_ts                    timestamptz NOT NULL,
  cash_lovelace              numeric(38,0) NOT NULL CHECK (cash_lovelace >= 0),
  position_base              numeric(38,0) NOT NULL CHECK (position_base >= 0),
  equity_lovelace            numeric(38,0) NOT NULL,
  -- what the position would fetch if sold now, net of fees; null when the executor cannot price it
  equity_executable_lovelace numeric(38,0),
  price                      numeric(38,18) NOT NULL CHECK (price > 0),
  PRIMARY KEY (run_id, tick_ts)
);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'finished';
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN ('running', 'finished', 'aborted'));
ALTER TABLE runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS last_tick_ts timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS stop_reason text;
-- true when the run consumed synthetic snapshots from dev:fake-collector; such a run is never evidence
ALTER TABLE runs ADD COLUMN IF NOT EXISTS rehearsal boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS runs_running ON runs (status) WHERE status = 'running';
