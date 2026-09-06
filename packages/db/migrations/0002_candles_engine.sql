-- Locally built candles: one row per (token, 5-minute tick) from pool_snapshots, using the deepest
-- ADA pool at that tick. With one observation per tick, open=high=low=close; the four columns exist
-- so strategies see the same shape as candles_external. Flow is NET reserve change vs the previous
-- tick of the SAME pool (null when the deepest pool changed). There is deliberately no `volume`.
CREATE TABLE IF NOT EXISTS candles (
  base_unit           text NOT NULL REFERENCES tokens(unit),
  tick_ts             timestamptz NOT NULL,
  pool_id             text NOT NULL,
  open                numeric(38,18) NOT NULL CHECK (open > 0),
  high                numeric(38,18) NOT NULL CHECK (high > 0),
  low                 numeric(38,18) NOT NULL CHECK (low > 0),
  close               numeric(38,18) NOT NULL CHECK (close > 0),
  close_reserve_base  numeric(38,0) NOT NULL CHECK (close_reserve_base > 0),
  close_reserve_quote numeric(38,0) NOT NULL CHECK (close_reserve_quote > 0),
  fee_bps             int NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  pool_type           text NOT NULL CHECK (pool_type IN ('cpmm')),
  tvl_lovelace        numeric(38,0) NOT NULL,
  net_flow_base       numeric(38,0),
  net_flow_quote      numeric(38,0),
  PRIMARY KEY (base_unit, tick_ts)
);

-- Imported history. Never merged into candles. Sparse: a bucket with no trade has no row.
CREATE TABLE IF NOT EXISTS candles_external (
  base_unit         text NOT NULL REFERENCES tokens(unit),
  tick_ts           timestamptz NOT NULL,
  source            text NOT NULL CHECK (source IN ('geckoterminal')),
  external_pool_id  text NOT NULL,
  open              numeric(38,18) NOT NULL CHECK (open > 0),
  high              numeric(38,18) NOT NULL CHECK (high > 0),
  low               numeric(38,18) NOT NULL CHECK (low > 0),
  close             numeric(38,18) NOT NULL CHECK (close > 0),
  volume_quote      numeric(38,6) NOT NULL CHECK (volume_quote >= 0),
  imported_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base_unit, tick_ts, source)
);

-- Which external pool stands for which token, and how we decided.
CREATE TABLE IF NOT EXISTS external_pool_map (
  base_unit         text NOT NULL REFERENCES tokens(unit),
  source            text NOT NULL CHECK (source IN ('geckoterminal')),
  external_pool_id  text NOT NULL,
  external_dex      text NOT NULL,
  match_method      text NOT NULL CHECK (match_method IN ('identifier', 'pair_largest_reserve')),
  reserve_usd       numeric(38,2),
  matched_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base_unit, source)
);

-- Provenance for every number a backtest or paper run prints.
CREATE TABLE IF NOT EXISTS runs (
  id                bigserial PRIMARY KEY,
  mode              text NOT NULL CHECK (mode IN ('backtest', 'paper')),
  strategy_id       text NOT NULL,
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  git_sha           text NOT NULL,
  base_unit         text NOT NULL REFERENCES tokens(unit),
  data_source       text NOT NULL CHECK (data_source IN ('candles', 'candles_external')),
  fill_model        text NOT NULL CHECK (fill_model IN ('cpmm_observed', 'cpmm_synthetic_depth')),
  data_from         timestamptz NOT NULL,
  data_to           timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  summary           jsonb
);

-- One row per intent, filled or rejected. Amounts in smallest units of unit_in / unit_out.
CREATE TABLE IF NOT EXISTS paper_orders (
  run_id              bigint NOT NULL REFERENCES runs(id),
  seq                 int NOT NULL,
  ts_intent           timestamptz NOT NULL,
  ts_fill             timestamptz,
  base_unit           text NOT NULL REFERENCES tokens(unit),
  pool_id             text,
  side                text NOT NULL CHECK (side IN ('buy', 'sell')),
  unit_in             text NOT NULL,
  amount_in           numeric(38,0) NOT NULL CHECK (amount_in > 0),
  unit_out            text,
  amount_out          numeric(38,0) CHECK (amount_out >= 0),
  mid_price           numeric(38,18),
  fill_price          numeric(38,18),
  pool_fee_in         numeric(38,0),
  batcher_fee_lovelace numeric(38,0),
  network_fee_lovelace numeric(38,0),
  slippage_bps        int,
  status              text NOT NULL CHECK (status IN ('filled', 'rejected')),
  reject_reason       text,
  reason              text NOT NULL,
  PRIMARY KEY (run_id, seq),
  CHECK ((status = 'filled') = (amount_out IS NOT NULL AND ts_fill IS NOT NULL)),
  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS candles_external_base_tick ON candles_external (base_unit, tick_ts);
