-- Per-venue Blockfrost provider-call counts for a run's discovery tick (null on a refresh tick, or
-- when discovery ran against a PoolSource that doesn't track this — see DiscoveryCallsSource in
-- packages/collector/src/source.ts). Motivated by run 50, the first real collector tick against
-- mainnet: 66 min, 39,781 total calls, of which Splash alone burned roughly 24k finding zero usable
-- pools (Dexter 5.4.10 never returns a Splash pool regardless of discovery strategy — see venues.ts).
-- Read by `status` to print the top venues by calls for the latest discovery tick.
ALTER TABLE collector_runs ADD COLUMN IF NOT EXISTS discovery_calls jsonb;
