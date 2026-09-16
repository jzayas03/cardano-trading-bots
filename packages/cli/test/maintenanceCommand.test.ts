import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maintenanceCommand, type MaintenanceDeps } from '../src/commands/maintenance.js';

/**
 * A maintenance window is the one mechanism here that can make a FAIL not page. Everything about
 * it is bounded on purpose: an explicit length, a hard cap, no silent extension, an end that is
 * announced, and a file the watchdog expires on its own. `status` never sends anything.
 */
const BASE = 'https://hc.example.test/ping/00000000-0000-4000-8000-000000000000';
const NOW = new Date('2026-09-16T12:00:00Z');
const env = { DATABASE_URL: 'postgres://ctb:ctb_local_only@localhost:5433/ctb', CTB_HEALTHCHECK_URL: BASE };
const log = pino({ level: 'silent' });

type Sent = { kind: string | number; body: string; url: string | undefined };

let dir: string;
let path: string;
let out: string[];
let err: string[];
let sent: Sent[];

function deps(extra: Partial<MaintenanceDeps> = {}): MaintenanceDeps {
  const report: MaintenanceDeps['report'] = async (url, kind, body) => {
    sent.push({ kind, body, url });
    return url === undefined ? { outcome: 'disabled' } : { outcome: 'accepted', status: 200, responseBody: 'OK', host: new URL(url).host };
  };
  return { report, env, path, now: () => NOW, ...extra };
}

const iso = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctb-maint-'));
  path = join(dir, 'ctb-maintenance.json');
  out = [];
  err = [];
  sent = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('maintenance start', () => {
  it('writes the window (mode 0600), sends and prints the start notice, exits 0', async () => {
    await maintenanceCommand(log, ['start', '--minutes', '45', '--reason', 'drill'], deps());
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ until: iso(45), reason: 'drill', declaredAt: NOW.toISOString() });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(sent).toEqual([{ kind: 'log', body: `maintenance started until ${iso(45)} (45 min): drill`, url: BASE }]);
    expect(out.join('\n')).toContain(`maintenance started until ${iso(45)} (45 min): drill`);
  });

  it('refuses more than 240 minutes (exit 2) without writing', async () => {
    await maintenanceCommand(log, ['start', '--minutes', '241', '--reason', 'drill'], deps());
    expect(process.exitCode).toBe(2);
    expect(existsSync(path)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('refuses a missing, zero, negative or non-integer --minutes (exit 2)', async () => {
    for (const bad of [[], ['--minutes', '0'], ['--minutes', '-5'], ['--minutes', '1.5'], ['--minutes', 'soon']]) {
      process.exitCode = undefined;
      await maintenanceCommand(log, ['start', ...bad, '--reason', 'drill'], deps());
      expect(process.exitCode, bad.join(' ')).toBe(2);
    }
    expect(existsSync(path)).toBe(false);
  });

  it('refuses an empty or missing reason (exit 2)', async () => {
    await maintenanceCommand(log, ['start', '--minutes', '45', '--reason', ''], deps());
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await maintenanceCommand(log, ['start', '--minutes', '45'], deps());
    expect(process.exitCode).toBe(2);
    expect(existsSync(path)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('refuses to start while a window is active (exit 1): use `maintenance end` first', async () => {
    writeFileSync(path, JSON.stringify({ until: iso(30), reason: 'earlier', declaredAt: iso(-15) }));
    await maintenanceCommand(log, ['start', '--minutes', '45', '--reason', 'drill'], deps());
    expect(process.exitCode).toBe(1);
    expect(err.join('\n')).toContain('use `maintenance end` first');
    expect(JSON.parse(readFileSync(path, 'utf8')).reason).toBe('earlier');
    expect(sent).toEqual([]);
  });

  it('replaces an expired window rather than refusing', async () => {
    writeFileSync(path, JSON.stringify({ until: iso(-1), reason: 'old', declaredAt: iso(-46) }));
    await maintenanceCommand(log, ['start', '--minutes', '10', '--reason', 'new'], deps());
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8')).reason).toBe('new');
  });

  it('still writes and prints when CTB_HEALTHCHECK_URL is unset; report is disabled', async () => {
    await maintenanceCommand(log, ['start', '--minutes', '45', '--reason', 'drill'], deps({ env: { DATABASE_URL: env.DATABASE_URL } }));
    expect(process.exitCode).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(sent).toEqual([{ kind: 'log', body: `maintenance started until ${iso(45)} (45 min): drill`, url: undefined }]);
    expect(out.join('\n')).toContain('maintenance started');
  });
});

describe('maintenance end', () => {
  it('deletes the file and sends the manual end notice with the reason', async () => {
    writeFileSync(path, JSON.stringify({ until: iso(30), reason: 'drill', declaredAt: iso(-15) }));
    await maintenanceCommand(log, ['end'], deps());
    expect(process.exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(sent).toEqual([{ kind: 'log', body: 'maintenance ended (manual): drill', url: BASE }]);
    expect(out.join('\n')).toContain('maintenance ended (manual): drill');
  });

  it('exits 0 with a note when there is no window, and sends nothing', async () => {
    await maintenanceCommand(log, ['end'], deps());
    expect(process.exitCode).toBe(0);
    expect(out.join('\n')).toContain('no maintenance window');
    expect(sent).toEqual([]);
  });

  it('still deletes and prints when CTB_HEALTHCHECK_URL is unset', async () => {
    writeFileSync(path, JSON.stringify({ until: iso(30), reason: 'drill', declaredAt: iso(-15) }));
    await maintenanceCommand(log, ['end'], deps({ env: { DATABASE_URL: env.DATABASE_URL } }));
    expect(process.exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(sent).toEqual([{ kind: 'log', body: 'maintenance ended (manual): drill', url: undefined }]);
  });
});

describe('maintenance status', () => {
  it('prints the active window with minutes left and never reports', async () => {
    writeFileSync(path, JSON.stringify({ until: iso(30), reason: 'drill', declaredAt: iso(-15) }));
    await maintenanceCommand(log, ['status'], deps());
    expect(process.exitCode).toBe(0);
    expect(out.join('\n')).toBe(`active until ${iso(30)} (30 min left): drill`);
    expect(sent).toEqual([]);
  });

  it('prints no maintenance window when there is none or it has expired', async () => {
    await maintenanceCommand(log, ['status'], deps());
    expect(out.join('\n')).toBe('no maintenance window');
    writeFileSync(path, JSON.stringify({ until: iso(-1), reason: 'old', declaredAt: iso(-46) }));
    await maintenanceCommand(log, ['status'], deps());
    expect(out.at(-1)).toContain('no maintenance window');
    expect(process.exitCode).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe('maintenance usage', () => {
  it('exits 2 on an unknown subcommand', async () => {
    await maintenanceCommand(log, ['pause'], deps());
    expect(process.exitCode).toBe(2);
    expect(err.join('\n')).toContain('usage');
    expect(sent).toEqual([]);
  });
});
