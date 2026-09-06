-- Universe mirror. `unit` = policy_id || asset_name_hex, the Cardano asset identifier.
CREATE TABLE IF NOT EXISTS tokens (
  unit            text PRIMARY KEY,
  policy_id       text NOT NULL CHECK (length(policy_id) = 56),
  asset_name_hex  text NOT NULL,
  ticker          text NOT NULL,
  decimals        smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  category        text NOT NULL,
  seeded_at       date NOT NULL,
  seed_source     text NOT NULL,
  CHECK (unit = policy_id || asset_name_hex)
);

-- One row per collector tick. This is the liveness signal: a gap here is visible in one query.
CREATE TABLE IF NOT EXISTS collector_runs (
  id              bigserial PRIMARY KEY,
  tick_ts         timestamptz NOT NULL,          -- interval bucket the tick belongs to
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz,
  pools_attempted int NOT NULL DEFAULT 0,
  pools_failed    int NOT NULL DEFAULT 0,
  pools_written   int NOT NULL DEFAULT 0,
  provider_calls  int NOT NULL DEFAULT 0,        -- Blockfrost calls made by this tick
  discovered      boolean NOT NULL DEFAULT false, -- true when this tick ran full pool discovery
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS collector_runs_tick_ts ON collector_runs (tick_ts DESC);

-- One row per pool per tick. Reserves are smallest units. Only constant-product pools are accepted;
-- widening pool_type is a deliberate migration, never a silent write.
CREATE TABLE IF NOT EXISTS pool_snapshots (
  run_id          bigint NOT NULL REFERENCES collector_runs(id),
  tick_ts         timestamptz NOT NULL,
  dex             text NOT NULL,
  pool_id         text NOT NULL,                 -- dex || ':' || dexter identifier
  pool_address    text NOT NULL,
  base_unit       text NOT NULL REFERENCES tokens(unit),
  quote_unit      text NOT NULL DEFAULT 'lovelace' CHECK (quote_unit = 'lovelace'),
  reserve_base    numeric(38,0) NOT NULL CHECK (reserve_base >= 0),
  reserve_quote   numeric(38,0) NOT NULL CHECK (reserve_quote >= 0),
  fee_bps         int NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  pool_type       text NOT NULL CHECK (pool_type IN ('cpmm')),
  tvl_lovelace    numeric(38,0) NOT NULL CHECK (tvl_lovelace >= 0),
  block_height    bigint NOT NULL,
  observed_at     timestamptz NOT NULL,
  PRIMARY KEY (pool_id, tick_ts)
);
CREATE INDEX IF NOT EXISTS pool_snapshots_base_tick ON pool_snapshots (base_unit, tick_ts);
