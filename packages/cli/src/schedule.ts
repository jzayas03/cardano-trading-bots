/** Milliseconds until the next interval boundary, so ticks land at :00, :05, :10 regardless of start time. */
export function msUntilNextBoundary(now: Date, intervalSec: number): number {
  const ms = intervalSec * 1000;
  const next = (Math.floor(now.getTime() / ms) + 1) * ms;
  return next - now.getTime();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      // Remove the listener on normal completion too, or a long-lived signal (the `collect`
      // loop's `stop.signal`) accumulates one 'abort' listener per completed tick forever.
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
