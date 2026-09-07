/**
 * Pins uPlot 1.6.32 to the exact bytes verified in the plan's Facts (do not re-derive: `npm pack
 * uplot@1.6.32`, extract, and the three files under `dist/`/`LICENSE` are these bytes). uPlot is
 * vendored, never a `package.json` dependency — this guard fails if it ever creeps back in as one.
 *
 * Proved red on 2026-09-07 by flipping one byte of `vendor/uPlot.min.css` (the size assertion caught
 * it immediately; the sha256 assertion caught it even when the byte flip happened to preserve length)
 * and restoring the original file from the `npm pack` extraction afterwards.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VENDOR = resolve(import.meta.dirname, '../vendor');
const PACKAGE_JSON = resolve(import.meta.dirname, '../package.json');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const EXPECTED = [
  { file: 'uPlot.iife.min.js', bytes: 51_081, sha256: '19c8d4c6ad88929a79f4ae49d6f7161566dfd0ba3d15cc495e974f787eb78f1f' },
  { file: 'uPlot.min.css', bytes: 1_857, sha256: 'df630c6a8d6f8eeaff264b50f73ce5b114f646ffd9a0bb74f049b0a00135fa04' },
  { file: 'LICENSE.uplot', bytes: 1_078, sha256: '8f989229699b4fe2f1a0432d0e9edc338a8a911e250e2d1b01ecd770a5f5b1bd' },
] as const;

describe('vendored uPlot 1.6.32', () => {
  for (const { file, bytes, sha256: expectedSha } of EXPECTED) {
    it(`${file} matches the pinned size and sha256`, () => {
      const buf = readFileSync(resolve(VENDOR, file));
      expect(buf.byteLength).toBe(bytes);
      expect(sha256(buf)).toBe(expectedSha);
    });
  }

  it('is never added as a package.json dependency — it is checked in as files, not installed', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('uplot');
  });
});
