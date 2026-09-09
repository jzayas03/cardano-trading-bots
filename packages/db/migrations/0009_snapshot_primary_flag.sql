-- Which snapshots the candle builder may use.
--
-- The collector refreshes ONE pool per token — the deepest — and `buildCandles` picks the deepest
-- pool in each bucket and takes every price from it. Multi-venue sampling writes snapshots for the
-- OTHER venues too, so that cross-DEX spreads can be measured. Those rows must never reach a candle.
--
-- Without this flag they could. `buildCandles` re-picks the deepest pool per bucket from whatever
-- rows exist, so a secondary pool that was momentarily deeper — or a tick where the primary's
-- snapshot is missing — would switch the candle's pool mid-series. That is the "splice" this project
-- already knows about (docs/ops/2026-09-07-first-real-candles.md: 16 of 20 tokens spliced across
-- pools during a 2-hour MinswapV2 outage), and it is the one thing that must not happen to a running
-- 7-day paper run.
--
-- DEFAULT true so every existing row keeps the meaning it already had: everything collected before
-- multi-venue sampling was a primary, deepest-pool observation.
ALTER TABLE pool_snapshots
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT true;

-- Candle builds filter on this, and they read by (base_unit, tick_ts) since a watermark.
CREATE INDEX IF NOT EXISTS pool_snapshots_primary_idx
  ON pool_snapshots (base_unit, tick_ts) WHERE is_primary;
