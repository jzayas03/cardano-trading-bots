import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A maintenance window that could be created without a bound, or that could outlive its own
 * expiry, is the same "silently wrong" shape as the 2026-09-08 watchdog: a mechanism that looks
 * like it is protecting you while it is doing nothing. These pins are on the source text because
 * the properties are about which code path calls what, which a unit test on the pure module
 * cannot see.
 */
function src(rel: string): string {
  const p = fileURLToPath(new URL(rel, import.meta.url));
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

const MAINTENANCE = src('../src/commands/maintenance.ts');
const ALERTING = src('../src/alerting.ts');
const WATCH = src('../src/commands/watch.ts');

describe('maintenance window guards', () => {
  it('the start path is bounded by MAX_MAINTENANCE_MINUTES', () => {
    const start = MAINTENANCE.indexOf("'start'");
    expect(start).toBeGreaterThan(-1);
    expect(MAINTENANCE.indexOf('MAX_MAINTENANCE_MINUTES', start)).toBeGreaterThan(start);
  });

  it('--minutes has no default: a window is never created without an explicit length', () => {
    expect(MAINTENANCE).toContain("'--minutes'");
    // No `?? <number>` / `?? '<number>'` / `|| <number>` fallback anywhere near the flag.
    expect(MAINTENANCE).not.toMatch(/--minutes'\)\s*\?\?\s*['"]?\d/);
    expect(MAINTENANCE).not.toMatch(/--minutes'\)\s*\|\|\s*['"]?\d/);
    expect(MAINTENANCE).not.toMatch(/minutes\s*=\s*\d+/);
  });

  it('the end path deletes the file', () => {
    const end = MAINTENANCE.indexOf("'end'");
    expect(end).toBeGreaterThan(-1);
    expect(MAINTENANCE.indexOf('deleteMaintenanceFile(', end)).toBeGreaterThan(end);
  });

  it('the watchdog expiry path deletes the file', () => {
    const expiry = WATCH.indexOf('expired');
    expect(expiry).toBeGreaterThan(-1);
    expect(WATCH.indexOf('deleteMaintenanceFile(', expiry)).toBeGreaterThan(expiry);
  });

  it('CONTROL: the guard is reading the real files', () => {
    expect(MAINTENANCE).toContain('export async function maintenanceCommand');
    expect(MAINTENANCE.length).toBeGreaterThan(500);
    expect(ALERTING).toContain('export function deleteMaintenanceFile');
    expect(ALERTING.length).toBeGreaterThan(500);
    expect(WATCH).toContain('export async function watchCommand');
  });
});
