/** All inputs oldest -> newest. Null means "not enough data", never NaN. */

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i]!;
  return s / period;
}

export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let e = sma(values.slice(0, period), period)!;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

export function rsi(closes: number[], period: number): number | null {
  if (period <= 0 || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  if (gain === 0) return 0;
  return 100 - 100 / (1 + gain / loss);
}

export function pctChange(values: number[], lookback: number): number | null {
  if (lookback <= 0 || values.length <= lookback) return null;
  const then = values[values.length - 1 - lookback]!;
  if (then === 0) return null;
  return values[values.length - 1]! / then - 1;
}

export function spikeRatio(values: Array<number | null>, period: number): number | null {
  const last = values[values.length - 1];
  if (last === null || last === undefined) return null;
  const priors = values.slice(0, -1).filter((v): v is number => v !== null);
  const base = sma(priors, period);
  if (base === null || base === 0) return null;
  return last / base;
}

export function crossed(fastPrev: number, slowPrev: number, fastNow: number, slowNow: number): 'up' | 'down' | null {
  if (fastPrev <= slowPrev && fastNow > slowNow) return 'up';
  if (fastPrev >= slowPrev && fastNow < slowNow) return 'down';
  return null;
}
