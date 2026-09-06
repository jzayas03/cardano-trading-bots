export interface RetryOptions {
  attempts: number; baseMs: number; maxMs: number; budgetMs: number;
  isTransient: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; message: string }) => void;
}

const TRANSIENT = /\b(429|5\d\d)\b|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|timed out|TimeoutError/;

export function isTransientHttpError(err: unknown): boolean {
  if (err instanceof Error) return TRANSIENT.test(err.message) || TRANSIENT.test(err.name);
  return false;
}

/** Exponential backoff with full jitter, bounded by attempts AND a wall-clock budget. Non-transient errors escape at once. */
export async function retryWithBackoff<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  let spent = 0;
  let last: unknown;
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!o.isTransient(err)) throw err;
      if (attempt === o.attempts) break;
      const cap = Math.min(o.maxMs, o.baseMs * 2 ** (attempt - 1));
      const delay = Math.floor(cap * random());
      if (spent + cap > o.budgetMs) {
        throw new Error(`${(err as Error).message ?? String(err)} (retry budget ${o.budgetMs} ms exhausted after ${attempt} attempts)`);
      }
      o.onRetry?.({ attempt, delayMs: delay, message: (err as Error).message ?? String(err) });
      await sleep(delay);
      spent += delay;
    }
  }
  throw new Error(`${(last as Error)?.message ?? String(last)} (after ${o.attempts} attempts)`);
}
