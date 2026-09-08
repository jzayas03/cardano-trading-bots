-- The pool set the collector refreshes, persisted so a RESTART does not buy a discovery sweep.
--
-- Why this table and not `pool_snapshots`, which already holds a row per pool per tick:
-- `poolToSnapshot` normalises every pool to (base_unit, quote_unit='lovelace') and throws the
-- A/B ORDERING away. Dexter matches a refreshed pool to the requested one on
-- `uuid = ${dex}.${assetAName}/${assetBName}.${identifier}` (LiquidityPool.uuid, a getter), so
-- "ADA/SNEK" and "SNEK/ADA" are different pools to it. Rehydrating from `pool_snapshots` would
-- therefore have to GUESS the order, and a wrong guess is worse than the bug it fixes: every
-- refresh returns undefined, `knownPoolCount()` stays non-zero so discovery never re-runs, and the
-- collector writes nothing for as long as it is left alone. This table stores the shape exactly as
-- discovery produced it, ordering and decimals included.
--
-- Reserves are stored for completeness and are NOT authoritative -- a refresh overwrites them on the
-- first tick. Never read a price out of this table; read `pool_snapshots`.
CREATE TABLE IF NOT EXISTS collector_pool_cache (
  pool_id           text PRIMARY KEY,
  dex               text        NOT NULL,
  identifier        text        NOT NULL,
  address           text        NOT NULL,
  -- 'lovelace', or {"policyId","nameHex","decimals"} -- exactly LiquidityPoolShape's asset union.
  asset_a           jsonb       NOT NULL,
  asset_b           jsonb       NOT NULL,
  -- numeric, not bigint: a reserve can exceed 2^63 and these are written back as strings.
  reserve_a         numeric(40, 0) NOT NULL,
  reserve_b         numeric(40, 0) NOT NULL,
  pool_fee_percent  double precision NOT NULL,
  cached_at         timestamptz NOT NULL
);

-- The whole cache is replaced on each successful discovery, so this is only for the digest.
CREATE INDEX IF NOT EXISTS collector_pool_cache_cached_at_idx ON collector_pool_cache (cached_at);
