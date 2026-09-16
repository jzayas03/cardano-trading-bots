import { describe, expect, it } from 'vitest';
import { knownSecretsFrom, report } from '../src/alerting.js';

/**
 * The one function that touches the network. The stub must reproduce the property under test:
 * the service answers a wrong UUID with HTTP 200 and body "OK (not found)", so a stub that only
 * varies the status would prove nothing about the rule that matters.
 */
const BASE = 'https://hc.example.test/ping/00000000-0000-4000-8000-000000000000';

type Call = { url: string; init: RequestInit | undefined };

function stub(status: number, body: string): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function throwing(err: unknown): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    throw err;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('report', () => {
  it('is disabled without a URL and never calls fetch', async () => {
    const s = stub(200, 'OK');
    expect(await report(undefined, 'alive', '', s.fetchImpl)).toEqual({ outcome: 'disabled' });
    expect(s.calls).toHaveLength(0);
  });

  it('is accepted on 200 OK, names the host, and carries no path anywhere in the result', async () => {
    const s = stub(200, 'OK');
    const r = await report(BASE, 'alive', 'watch: OK', s.fetchImpl);
    expect(r.outcome).toBe('accepted');
    expect(r.status).toBe(200);
    expect(r.host).toBe('hc.example.test');
    expect(r).not.toHaveProperty('path');
    expect(JSON.stringify(r)).not.toContain('/ping/');
    expect(JSON.stringify(r)).not.toContain('00000000-0000');
  });

  it('is rejected on 200 "OK (not found)" and surfaces that body', async () => {
    const s = stub(200, 'OK (not found)');
    const r = await report(BASE, 'alive', 'watch: OK', s.fetchImpl);
    expect(r.outcome).toBe('rejected');
    expect(r.status).toBe(200);
    expect(r.responseBody).toBe('OK (not found)');
    expect(r.host).toBe('hc.example.test');
  });

  it('is unreachable when fetch throws an AbortError (the timeout)', async () => {
    const s = throwing(new DOMException('The operation was aborted', 'AbortError'));
    const r = await report(BASE, 'alive', 'watch: OK', s.fetchImpl);
    expect(r.outcome).toBe('unreachable');
    expect(r.host).toBe('hc.example.test');
    expect(r.status).toBeUndefined();
  });

  it('never throws: a plain Error from fetch is unreachable', async () => {
    const s = throwing(new Error('ECONNREFUSED'));
    await expect(report(BASE, 'alive', 'watch: OK', s.fetchImpl)).resolves.toMatchObject({ outcome: 'unreachable' });
  });

  it('names the reason for unreachable by error name and cause code, never by URL', async () => {
    const e = new TypeError('fetch failed');
    (e as { cause?: unknown }).cause = Object.assign(new Error(`connect ECONNREFUSED ${BASE}`), { code: 'ECONNREFUSED' });
    const r = await report(BASE, 'alive', 'watch: OK', throwing(e).fetchImpl);
    expect(r.reason).toBe('TypeError: ECONNREFUSED');
    expect(JSON.stringify(r)).not.toContain('/ping/');
    const t = await report(BASE, 'alive', 'watch: OK', throwing(new DOMException('timed out', 'TimeoutError')).fetchImpl);
    expect(t.reason).toBe('TimeoutError');
  });

  it.each([
    ['fail', `${BASE}/fail`],
    ['log', `${BASE}/log`],
    [3, `${BASE}/3`],
    ['alive', BASE],
    ['start', `${BASE}/start`],
  ] as const)('kind %s POSTs to the right suffix', async (kind, url) => {
    const s = stub(200, 'OK');
    await report(BASE, kind, 'body', s.fetchImpl);
    expect(s.calls.map((c) => c.url)).toEqual([url]);
  });

  it('sends a POST with the body as text and an abort signal', async () => {
    const s = stub(200, 'OK');
    await report(BASE, 'fail', 'FAIL: x — y\nwatch: 1 FAIL (x)', s.fetchImpl);
    const init = s.calls[0]!.init!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('FAIL: x — y\nwatch: 1 FAIL (x)');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps only the first 200 characters of the response body', async () => {
    const s = stub(500, 'x'.repeat(1_000));
    const r = await report(BASE, 'alive', 'body', s.fetchImpl);
    expect(r.outcome).toBe('rejected');
    expect(r.responseBody).toHaveLength(200);
  });
});

describe('knownSecretsFrom', () => {
  it('collects the values the config loader treats as secrets, plus the password inside each URL', () => {
    const secrets = knownSecretsFrom({
      DATABASE_URL: 'postgres://ctb:pw-one@localhost:5433/ctb',
      DASHBOARD_DATABASE_URL: '',
      POSTGRES_PASSWORD: 'pw-two',
      BLOCKFROST_PROJECT_ID: 'mainnetabc',
      R2_ACCESS_KEY_ID: 'r2-access-key-id',
      R2_SECRET_ACCESS_KEY: 'r2-secret-key',
      R2_ACCOUNT_ID: 'r2-account',
      CTB_HEALTHCHECK_URL: 'https://hc.example.test/ping/uuid',
      LOG_LEVEL: 'info',
    });
    expect(secrets).toEqual(expect.arrayContaining([
      'postgres://ctb:pw-one@localhost:5433/ctb', 'pw-one', 'pw-two', 'mainnetabc', 'r2-access-key-id', 'r2-secret-key', 'r2-account',
      'https://hc.example.test/ping/uuid',
    ]));
    expect(secrets).not.toContain('info');
    expect(secrets).not.toContain('');
  });

  it('is empty on an empty env', () => {
    expect(knownSecretsFrom({})).toEqual([]);
  });

  it('drops a password shorter than 4 characters: it would match inside ordinary words and redact every body', () => {
    const secrets = knownSecretsFrom({ DATABASE_URL: 'postgres://ctb:x@localhost:5433/ctb' });
    expect(secrets).toEqual(['postgres://ctb:x@localhost:5433/ctb']);
  });
});
