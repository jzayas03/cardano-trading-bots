import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertCommand, type AlertDeps } from '../src/commands/alert.js';
import type { ReportResult } from '../src/alerting.js';

/**
 * `alert` is the operator's proof that the pipe works, so its exit code is the contract: 0 only
 * when the service said "OK", 1 when it answered anything else or could not be reached, 2 when
 * the command was misused or alerting is off. Every message names the host and the status, never
 * the path: the URL is the credential.
 */
const BASE = 'https://hc.example.test/ping/00000000-0000-4000-8000-000000000000';
const env = { DATABASE_URL: 'postgres://ctb:ctb_local_only@localhost:5433/ctb', CTB_HEALTHCHECK_URL: BASE };
const log = pino({ level: 'silent' });

type Sent = { kind: string | number; body: string; url: string | undefined };

function deps(result: Omit<ReportResult, 'host'>, extra: Partial<AlertDeps> = {}): { sent: Sent[]; deps: AlertDeps } {
  const sent: Sent[] = [];
  const report: AlertDeps['report'] = async (url, kind, body) => {
    sent.push({ kind, body, url });
    return url === undefined ? { outcome: 'disabled' } : { ...result, host: new URL(url).host };
  };
  return { sent, deps: { report, env, hostname: () => 'box-1', now: () => new Date('2026-09-16T12:00:00Z'), ...extra } };
}

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('alert send', () => {
  it('sends the given kind and body and exits 0 on accepted', async () => {
    const d = deps({ outcome: 'accepted', status: 200, responseBody: 'OK' });
    await alertCommand(log, ['send', '--kind', 'fail', '--body', 'x'], d.deps);
    expect(d.sent).toEqual([{ kind: 'fail', body: 'x', url: BASE }]);
    expect(process.exitCode).toBe(0);
    expect(out.join('\n')).toContain('accepted');
    expect(out.join('\n')).toContain('hc.example.test');
  });

  it('exits 1 on rejected with the status and the response body, never the path', async () => {
    const d = deps({ outcome: 'rejected', status: 200, responseBody: 'OK (not found)' });
    await alertCommand(log, ['send', '--kind', 'log', '--body', 'x'], d.deps);
    expect(process.exitCode).toBe(1);
    const all = [...out, ...err].join('\n');
    expect(all).toContain('200');
    expect(all).toContain('OK (not found)');
    expect(all).toContain('hc.example.test');
    expect(all).not.toContain('/ping/');
    expect(all).not.toContain('00000000-0000');
  });

  it('exits 1 on unreachable', async () => {
    const d = deps({ outcome: 'unreachable', reason: 'TimeoutError' });
    await alertCommand(log, ['send', '--kind', 'alive', '--body', 'x'], d.deps);
    expect(process.exitCode).toBe(1);
    expect([...out, ...err].join('\n')).toContain('unreachable');
  });

  it('exits 2 with the fixed message when CTB_HEALTHCHECK_URL is unset, and sends nothing', async () => {
    const d = deps({ outcome: 'accepted' }, { env: { DATABASE_URL: env.DATABASE_URL } });
    await alertCommand(log, ['send', '--kind', 'fail', '--body', 'x'], d.deps);
    expect(process.exitCode).toBe(2);
    expect(err.join('\n')).toContain('CTB_HEALTHCHECK_URL is not set; alerting is off');
    expect(d.sent).toEqual([]);
  });

  it('exits 2 with usage on a kind other than alive|fail|log', async () => {
    const d = deps({ outcome: 'accepted' });
    await alertCommand(log, ['send', '--kind', '3', '--body', 'x'], d.deps);
    expect(process.exitCode).toBe(2);
    expect(err.join('\n')).toContain('usage');
    expect(d.sent).toEqual([]);
  });

  it('exits 2 with usage on an unknown subcommand or none', async () => {
    const d = deps({ outcome: 'accepted' });
    await alertCommand(log, ['bogus'], d.deps);
    expect(process.exitCode).toBe(2);
    await alertCommand(log, [], d.deps);
    expect(process.exitCode).toBe(2);
    expect(d.sent).toEqual([]);
  });

  it('labels a body-less send so the drill is identifiable in the service log', async () => {
    const d = deps({ outcome: 'accepted', status: 200, responseBody: 'OK' });
    await alertCommand(log, ['send', '--kind', 'fail'], d.deps);
    expect(d.sent[0]!.body).toMatch(/^fail from box-1 at 2026-09-16T12:00:00/);
  });

  it('runs the body through the secret filter', async () => {
    const d = deps({ outcome: 'accepted', status: 200, responseBody: 'OK' });
    await alertCommand(log, ['send', '--kind', 'log', '--body', 'db is postgres://u:p@h/db'], d.deps);
    expect(d.sent[0]!.body).toBe('[redacted: body failed the secret filter]');
  });
});

describe('alert test', () => {
  it('sends a log report labelled TEST from <host> at <ISO>', async () => {
    const d = deps({ outcome: 'accepted', status: 200, responseBody: 'OK' });
    await alertCommand(log, ['test'], d.deps);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]!.kind).toBe('log');
    expect(d.sent[0]!.body).toMatch(/^TEST from \S+ at \d{4}-\d{2}-\d{2}T/);
    expect(d.sent[0]!.body).toBe('TEST from box-1 at 2026-09-16T12:00:00.000Z');
  });

  it('prints accepted (http 200 OK) host=<host> and exits 0', async () => {
    const d = deps({ outcome: 'accepted', status: 200, responseBody: 'OK' });
    await alertCommand(log, ['test'], d.deps);
    expect(process.exitCode).toBe(0);
    expect(out).toEqual(['accepted (http 200 OK) host=hc.example.test']);
  });

  it('prints rejected (http 200 "OK (not found)") host=<host> and exits 1', async () => {
    const d = deps({ outcome: 'rejected', status: 200, responseBody: 'OK (not found)' });
    await alertCommand(log, ['test'], d.deps);
    expect(process.exitCode).toBe(1);
    expect(err).toEqual(['rejected (http 200 "OK (not found)") host=hc.example.test']);
  });

  it('prints unreachable host=<host>: <reason> and exits 1', async () => {
    const d = deps({ outcome: 'unreachable', reason: 'TimeoutError' });
    await alertCommand(log, ['test'], d.deps);
    expect(process.exitCode).toBe(1);
    expect(err).toEqual(['unreachable host=hc.example.test: TimeoutError']);
  });

  it('never prints the path', async () => {
    for (const r of [
      { outcome: 'accepted' as const, status: 200, responseBody: 'OK' },
      { outcome: 'rejected' as const, status: 200, responseBody: 'OK (not found)' },
      { outcome: 'unreachable' as const, reason: 'TypeError: ECONNREFUSED' },
    ]) {
      out = []; err = [];
      await alertCommand(log, ['test'], deps(r).deps);
      const all = [...out, ...err].join('\n');
      expect(all).not.toContain('/ping/');
      expect(all).not.toContain('00000000-0000');
    }
  });

  it('exits 2 with the fixed message when CTB_HEALTHCHECK_URL is unset', async () => {
    const d = deps({ outcome: 'accepted' }, { env: { DATABASE_URL: env.DATABASE_URL } });
    await alertCommand(log, ['test'], d.deps);
    expect(process.exitCode).toBe(2);
    expect(err).toEqual(['CTB_HEALTHCHECK_URL is not set; alerting is off']);
    expect(d.sent).toEqual([]);
  });
});
