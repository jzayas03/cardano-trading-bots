export { PRICE_SCALE, PRICE_UNIT, priceScaled, ratioOf } from './decimal.js';
export { adaStr, coverageLine, dayAgo, feedCountersLine, priceChangePct, resumesOf, tokenStr } from './format.js';
export { summarizeDay, summarizeRun, type DaySummary } from './summary.js';
export { BLOCKFROST_FREE_DAILY_QUOTA, MIN_PROJECTION_ELAPSED_SEC, QUOTA_OK_BELOW, digestLines, utcMidnight, type DigestInput } from './digest.js';
export {
  checkDigestLines, checkDisk, checkEnv, checkFakeRows, checkMigrations, checkNode, checkProcesses,
  checkQuotaSpend, checkRecurringTickErrors, checkTickProductivity,
  LOW_DISK_BYTES, QUOTA_SPEND_WARN_AT, RECURRING_ERROR_TICKS_FAIL, UNPRODUCTIVE_TICKS_FAIL,
  verdict, type Check, type ProcessLine, type Status, type TickHealthRow,
} from './doctor.js';
export { DEFAULT_COLLECT_INTERVAL_SEC, DEFAULT_GRACE_SEC, heartbeatAgeCell, isHeartbeatStale } from './heartbeat.js';
export { compareRows, compareRunRows, COMPARE_REHEARSAL_BANNER, MIXED_TOKENS_WARNING, sweepRows, type CompareInput, type CompareRow, type CompareRunInput, type CompareRunRow, type SweepInput, type SweepRow } from './compare.js';
export { gridCombinations, gridRows, gridWarning, type GridInput, type GridRow } from './grid.js';
export * from './watch.js';
export * from './leadlag.js';
export * from './opportunity.js';
export { BASELINE_STRATEGIES, MAX_CAPITAL_DRIFT, MAX_GAPS_OVER_BOUND_PCT, MIN_COVERAGE_PCT, MIN_ROUND_TRIPS, MIN_WINDOW_OVERLAP, promotionVerdict, type PromotionCheck, type PromotionInput, type PromotionStatus, type PromotionVerdict, type RunContext } from './promotion.js';
export { afterDeployChecks, afterStopChecks, beforeStopChecks, MAX_BACKUP_AGE_HOURS, type AfterDeployFacts, type AfterStopFacts, type BeforeStopFacts } from './cutover.js';
export { bcaInterval, bcaStability, BOOTSTRAP_RESAMPLES, conservativeBounds, mean, STABILITY_TOLERANCE, type BcaInterval, type BcaOptions, type BcaStability, type Statistic } from './bootstrap.js';
export { ASSUMED_STAKING_APR_PCT, stakingCredit, withStakingCredit } from './staking.js';
export { roundTrips, roundTripStats, type RoundTrip, type RoundTripStats } from './roundTrips.js';
export { lpEntryRows, lpEntrySummary, type LpCandle, type LpEntryRow, type LpEntrySummary } from './lp.js';
