-- `candles_external` holds prices in USD; `candles` holds them in ADA. Nothing said so.
--
-- `geckoTerminal.ts` requested `ohlcv/minute?aggregate=5` with no `currency` parameter, and
-- GeckoTerminal defaults `currency` to `usd`. Measured 2026-09-09 on the SNEK/ADA MinswapV2 pool,
-- same pool on both sides: the implied rate (external close / our close) across 19 matched
-- timestamps was min 0.2145, max 0.2237, mean 0.2206, relative stddev 122 bps. A near-constant
-- multiplier is a currency rate. Price levels differed by ~7,800 bps, which looks like a broken
-- instrument and is entirely units.
--
-- It is not cosmetic. `docs/ops/2026-09-08-token-choice.md` chose the traded token by "% of windows
-- whose absolute return exceeds 2.16%", computed over these USD rows -- while the 2.16% floor is
-- ADA-denominated (batcher and network fees are ADA; the pool fee is charged against ADA reserves).
-- ADA/USD moved 432 bps over the ~17 hours sampled, twice the floor on its own. So the table
-- measured SNEK/USD, and the pair we trade is SNEK/ADA.
--
-- Existing rows are labelled 'usd' rather than deleted: they are three months of real history and
-- remain valid for anything genuinely asked in dollars. What must never happen again is the two
-- being mixed silently, so `denomination` joins the primary key and every read filters on it.
ALTER TABLE candles_external
  ADD COLUMN IF NOT EXISTS denomination text NOT NULL DEFAULT 'usd'
    CHECK (denomination IN ('usd', 'ada'));

-- The default exists only to label the rows already here. New writes state it explicitly, so drop
-- it: a future INSERT that forgets the column should fail loudly rather than silently claim USD.
ALTER TABLE candles_external ALTER COLUMN denomination DROP DEFAULT;

ALTER TABLE candles_external DROP CONSTRAINT IF EXISTS candles_external_pkey;
ALTER TABLE candles_external ADD CONSTRAINT candles_external_pkey
  PRIMARY KEY (base_unit, tick_ts, source, external_pool_id, denomination);
