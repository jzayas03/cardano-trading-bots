export interface RetryOptions {
  attempts: number; baseMs: number; maxMs: number; budgetMs: number;
  isTransient: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; message: string }) => void;
}

// Matches on message TEXT only, not a parsed HTTP status field — there is no structured status on
// these errors (Dexter/Blockfrost throw plain strings and Errors, not typed HTTP exceptions). This
// means a non-HTTP error message that happens to contain an isolated 3-digit token in the 4xx/5xx
// shape (e.g. an on-chain identifier or byte count that reads as "...503...") would be misclassified
// transient and retried. That is bounded, not unsafe: it costs at most `attempts` extra tries within
// `budgetMs` before rethrowing the original error — it can never turn a real failure into a false
// success, since retrying only re-runs the same failing call.
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
      // Compare like for like (finding I7): `spent` only ever accumulates the jittered DELAY, so
      // testing the un-jittered CAP against it abandoned a budget that had not been spent — under
      // full jitter the delay averages half the cap, so roughly half the budget went unused.
      if (spent + delay > o.budgetMs) {
        throw new Error(`${(err as Error).message ?? String(err)} (retry budget ${o.budgetMs} ms exhausted after ${attempt} attempts)`);
      }
      o.onRetry?.({ attempt, delayMs: delay, message: (err as Error).message ?? String(err) });
      await sleep(delay);
      spent += delay;
    }
  }
  throw new Error(`${(last as Error)?.message ?? String(last)} (after ${o.attempts} attempts)`);
}
