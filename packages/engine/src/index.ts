export { crossed, ema, pctChange, rsi, sma, spikeRatio } from './indicators.js';
export type { Candle, EquityPoint, Executor, FillResult, Intent, OrderRecord, Portfolio, RunCoverage, RunResult, RunSummaryStats, Strategy, StrategyContext, WorkingPool } from './types.js';
export { applyFill, equityLovelace } from './portfolio.js';
export { runEngine, Summarizer, summarize, type RunEngineDeps } from './loop.js';
export { buyAndHold, maCrossover, rsiMeanReversion, scheduledAccumulation, STRATEGIES } from './strategies/index.js';
export { gitShaOrUnknown, PgRunRepo, rowToRun, type FeedCounters, type NewRun, type RunningRun, type RunRepo, type RunRow, type RunsRowRaw } from './repo.js';
