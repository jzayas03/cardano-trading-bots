import { describe, expect, it } from 'vitest';
import { dashboardCheck, probeDashboard } from '../src/commands/doctor.js';

/** A `fetch` that never resolves on its own — only rejects once its `AbortSignal` fires, the way a
 * real timed-out request would. Used to exercise `probeDashboard`'s timeout path without a real
 * network call or a hanging test. */
function hangingFetch(): typeof fetch {
  return ((_url: string | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    })) as typeof fetch;
}

function refusingFetch(): typeof fetch {
  return (() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3210'))) as unknown as typeof fetch;
}

function respondingFetch(status: number): typeof fetch {
  return (() => Promise.resolve(new Response('ok', { status }))) as unknown as typeof fetch;
}

describe('dashboardCheck (pure)', () => {
  it('is always ok — a down dashboard is informational, never a FAIL or a WARN', () => {
    expect(dashboardCheck(true)).toEqual({ name: 'dashboard', status: 'ok', detail: 'running' });
    expect(dashboardCheck(false)).toEqual({ name: 'dashboard', status: 'ok', detail: 'not running' });
  });
});

describe('probeDashboard (injectable)', () => {
  it('resolves true when something answers, even with a non-2xx status', async () => {
    await expect(probeDashboard(respondingFetch(200), 'http://127.0.0.1:3210/', 50)).resolves.toBe(true);
    await expect(probeDashboard(respondingFetch(500), 'http://127.0.0.1:3210/', 50)).resolves.toBe(true);
  });

  it('resolves false on a refused connection, and never throws', async () => {
    await expect(probeDashboard(refusingFetch(), 'http://127.0.0.1:3210/', 50)).resolves.toBe(false);
  });

  it('resolves false on a timeout, and never throws or hangs the caller', async () => {
    await expect(probeDashboard(hangingFetch(), 'http://127.0.0.1:3210/', 10)).resolves.toBe(false);
  });
});
