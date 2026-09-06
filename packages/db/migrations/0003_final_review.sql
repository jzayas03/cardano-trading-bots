-- Final-review fix wave (2026-09-06). Three schema changes, all idempotent so this file can be
-- replayed on a database that already carries the SNEK external history from M2.

-- Finding C2: slippage and price impact are two different numbers and were being conflated.
-- `slippage_bps` is the fill against the mid at candle t (spec §4.5 — what the strategy saw when it
-- decided). `price_impact_bps` is the same fill against the t+1 pool it actually executed in. Storing
-- only one of them made `slippage_bps` unreproducible from the stored `mid_price`/`fill_price`.
ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS price_impact_bps int;

-- Finding I3: the old primary key (base_unit, tick_ts, source) could hold only ONE external pool per
-- token per tick. Re-pinning `external_pool_map` to a different pool therefore did not import a new
-- series — the new pool's rows collided with the old pool's and were dropped by ON CONFLICT DO
-- NOTHING, leaving one series silently stitched together from two pools with different prices.
-- Adding external_pool_id to the key lets both series coexist; readers join external_pool_map to say
-- which one they mean. Existing rows all share one external_pool_id per token, so the wider key
-- introduces no duplicates.
ALTER TABLE candles_external DROP CONSTRAINT IF EXISTS candles_external_pkey;
ALTER TABLE candles_external ADD CONSTRAINT candles_external_pkey
  PRIMARY KEY (base_unit, tick_ts, source, external_pool_id);

-- The new primary-key index is already prefixed by (base_unit, tick_ts), so this index served no
-- query the PK does not serve, while still costing a write on every imported row.
DROP INDEX IF EXISTS candles_external_base_tick;
