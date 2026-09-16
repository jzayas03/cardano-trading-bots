import { describe, expect, it } from 'vitest';
import {
  buildBody, classify, decideReport, evaluateMaintenance, filterSecrets,
  MAX_BODY_BYTES, MAX_MAINTENANCE_MINUTES, type Check, type MaintenanceState,
} from '../src/index.js';

/**
 * The decision half of the dead-man's switch: what a watchdog cycle sends and how a response is
 * read. Pure on purpose, so the rules that decide whether the founder is paged are testable
 * without a network, and so a maintenance window can be proven never to silence liveness.
 */

const ok: Check = { name: 'disk', status: 'ok', detail: '30 GB free' };
const warn: Check = { name: 'backup', status: 'warn', detail: 'newest backup is 27h old' };
const warn2: Check = { name: 'quota pace', status: 'warn', detail: 'WATCH 80%' };
const fail: Check = { name: 'paper ma-crossover', status: 'fail', detail: 'marked running but no process is running it' };
const fail2: Check = { name: 'collector tick', status: 'fail', detail: 'STALE 3 ticks' };

const NOW = new Date('2026-09-16T12:00:00Z');
const iso = (d: Date) => d.toISOString();
const minutesFrom = (base: Date, min: number) => new Date(base.getTime() + min * 60_000);

const active: MaintenanceState = { until: iso(minutesFrom(NOW, 45)), reason: 'drill', declaredAt: iso(NOW) };

describe('classify', () => {
  it('accepts only a 200 whose body is exactly OK', () => {
    expect(classify(200, 'OK', null)).toBe('accepted');
  });

  it('rejects a 200 whose body says the check was not found: a wrong UUID is not an error to the service', () => {
    expect(classify(200, 'OK (not found)', null)).toBe('rejected');
  });

  it('rejects a 200 that says rate limited', () => {
    expect(classify(200, 'OK (rate limited)', null)).toBe('rejected');
  });

  it('rejects a 4xx', () => {
    expect(classify(400, 'invalid url format', null)).toBe('rejected');
  });

  it('is unreachable on a thrown AbortError (the 10 s timeout)', () => {
    expect(classify(null, null, new DOMException('The operation was aborted', 'AbortError'))).toBe('unreachable');
  });

  it('is unreachable on any other thrown value', () => {
    expect(classify(null, null, new Error('ECONNREFUSED'))).toBe('unreachable');
  });
});

describe('filterSecrets', () => {
  const REDACTED = '[redacted: body failed the secret filter]';

  it('replaces the WHOLE body when a known secret appears anywhere in it', () => {
    const r = filterSecrets('FAIL: x — detail s3cr3t here\nwatch: 1 FAIL (x)', ['s3cr3t']);
    expect(r).toEqual({ body: REDACTED, redacted: true });
  });

  it('passes a clean body through unchanged', () => {
    expect(filterSecrets('FAIL: x — detail\nwatch: 1 FAIL (x)', ['s3cr3t'])).toEqual({ body: 'FAIL: x — detail\nwatch: 1 FAIL (x)', redacted: false });
  });

  it('redacts a postgres:// URL even when it is not in the known list', () => {
    expect(filterSecrets('FAIL: db — postgres://u:p@h/db unreachable', []).redacted).toBe(true);
  });

  it('redacts a 39-character alphanumeric token (a Blockfrost project id)', () => {
    const token = 'mainnet' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    expect(token).toHaveLength(39);
    expect(filterSecrets(`WARN: quota — key ${token} near limit`, []).redacted).toBe(true);
  });

  it('redacts an e-mail address but not a systemd instance name', () => {
    expect(filterSecrets('FAIL: owner — mail founder@example.com', []).redacted).toBe(true);
    expect(filterSecrets('FAIL: unit — ctb-paper@ma-crossover.service failed', []).redacted).toBe(false);
  });

  it('ignores empty entries in the known list rather than redacting everything', () => {
    expect(filterSecrets('watch: OK', ['', undefined as unknown as string]).redacted).toBe(false);
  });
});

describe('buildBody', () => {
  it('is the non-OK check lines followed by the verdict line, with doctor: replaced by watch:', () => {
    expect(buildBody([ok, warn, fail], 'doctor: 1 FAIL (paper ma-crossover), 1 warn', null)).toBe(
      'WARN: backup — newest backup is 27h old\n' +
      'FAIL: paper ma-crossover — marked running but no process is running it\n' +
      'watch: 1 FAIL (paper ma-crossover), 1 warn',
    );
  });

  it('is only the verdict line on a clean cycle', () => {
    expect(buildBody([ok], 'doctor: OK', null)).toBe('watch: OK');
  });

  it('prefixes an active maintenance window with its reason and end', () => {
    const body = buildBody([fail], 'doctor: 1 FAIL (paper ma-crossover)', active);
    expect(body.startsWith(`[maintenance: drill until ${active.until}]\n`)).toBe(true);
    expect(body.endsWith('watch: 1 FAIL (paper ma-crossover)')).toBe(true);
  });

  it('truncates a body over 8 kB and ends with a line that says so', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ name: `check ${i}`, status: 'fail' as const, detail: 'x'.repeat(100) }));
    const body = buildBody(many, 'doctor: 200 FAIL', null);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(body.split('\n').at(-1)).toBe('[truncated to 8 kB]');
    expect(MAX_BODY_BYTES).toBe(8 * 1024);
  });

  it('applies the secret filter', () => {
    const body = buildBody([{ name: 'db', status: 'fail', detail: 'postgres://u:p@h/db down' }], 'doctor: 1 FAIL (db)', null);
    expect(body).toBe('[redacted: body failed the secret filter]');
    expect(buildBody([fail], 'doctor: 1 FAIL (x)', null, ['no process'])).toBe('[redacted: body failed the secret filter]');
  });
});

describe('evaluateMaintenance', () => {
  it('is null when there is no file', () => {
    expect(evaluateMaintenance(null, NOW)).toBeNull();
  });

  it('is null on malformed JSON or a wrong shape', () => {
    expect(evaluateMaintenance('{not json', NOW)).toBeNull();
    expect(evaluateMaintenance('{"until": 5}', NOW)).toBeNull();
    expect(evaluateMaintenance(JSON.stringify({ until: 'yesterday', reason: 'x', declaredAt: iso(NOW) }), NOW)).toBeNull();
  });

  it('is null when until is more than 240 minutes ahead: our command never writes that', () => {
    expect(MAX_MAINTENANCE_MINUTES).toBe(240);
    const far = { until: iso(minutesFrom(NOW, 241)), reason: 'x', declaredAt: iso(NOW) };
    expect(evaluateMaintenance(JSON.stringify(far), NOW)).toBeNull();
    const edge = { until: iso(minutesFrom(NOW, 240)), reason: 'x', declaredAt: iso(NOW) };
    expect(evaluateMaintenance(JSON.stringify(edge), NOW)).toEqual(edge);
  });

  it('is expired with the reason when until is in the past', () => {
    const past = { until: iso(minutesFrom(NOW, -1)), reason: 'old', declaredAt: iso(minutesFrom(NOW, -46)) };
    expect(evaluateMaintenance(JSON.stringify(past), NOW)).toEqual({ expired: true, reason: 'old' });
  });

  it('is the window itself when active', () => {
    expect(evaluateMaintenance(JSON.stringify(active), NOW)).toEqual(active);
  });
});

describe('decideReport', () => {
  it('sends alive on a clean cycle', () => {
    expect(decideReport([ok], 'doctor: OK', null)).toEqual({ kind: 'alive', body: 'watch: OK' });
  });

  it('sends alive on a WARN-only cycle: warnings never page (f5acb93)', () => {
    const r = decideReport([ok, warn], 'doctor: OK with 1 warning (backup)', null);
    expect(r.kind).toBe('alive');
    expect(r.body).toBe('WARN: backup — newest backup is 27h old\nwatch: OK with 1 warning (backup)');
  });

  it('sends fail when any check FAILs', () => {
    const r = decideReport([ok, warn, fail], 'doctor: 1 FAIL (paper ma-crossover), 1 warn', null);
    expect(r.kind).toBe('fail');
    expect(r.body).toContain('FAIL: paper ma-crossover');
  });

  it('turns fail into alive during maintenance, with the window in the body', () => {
    const r = decideReport([fail, fail2], 'doctor: 2 FAIL (paper ma-crossover, collector tick)', active);
    expect(r.kind).toBe('alive');
    expect(r.body.startsWith(`[maintenance: drill until ${active.until}]`)).toBe(true);
    expect(r.body).toContain('FAIL: collector tick');
  });

  // T016 (US2): the founder reads the failing check on the phone, and warnings stay visible.
  it('with one FAIL and two WARN: kind fail, body has all three STATUS lines and the verdict', () => {
    const r = decideReport([ok, warn, warn2, fail], 'doctor: 1 FAIL (paper ma-crossover), 2 warn', null);
    expect(r.kind).toBe('fail');
    expect(r.body.split('\n')).toEqual([
      'WARN: backup — newest backup is 27h old',
      'WARN: quota pace — WATCH 80%',
      'FAIL: paper ma-crossover — marked running but no process is running it',
      'watch: 1 FAIL (paper ma-crossover), 2 warn',
    ]);
  });

  it('with WARN only: kind alive and the WARN lines are still in the body (FR-005)', () => {
    const r = decideReport([ok, warn, warn2], 'doctor: OK with 2 warnings (backup, quota pace)', null);
    expect(r.kind).toBe('alive');
    expect(r.body).toContain('WARN: backup — newest backup is 27h old');
    expect(r.body).toContain('WARN: quota pace — WATCH 80%');
    expect(r.body.endsWith('watch: OK with 2 warnings (backup, quota pace)')).toBe(true);
  });
});
