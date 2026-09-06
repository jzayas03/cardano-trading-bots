/** Milliseconds until the next interval boundary, so ticks land at :00, :05, :10 regardless of start time. */
export function msUntilNextBoundary(now: Date, intervalSec: number): number {
  const ms = intervalSec * 1000;
  const next = (Math.floor(now.getTime() / ms) + 1) * ms;
  return next - now.getTime();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
