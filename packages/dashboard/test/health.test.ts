import { digestLines, type Check, type DigestInput } from '@ctb/reports';
import { describe, expect, it } from 'vitest';
import { renderHealth } from '../src/pages/health.js';

// Copied from packages/cli/test/digest.test.ts's `base` fixture (do not re-derive: same DigestInput,
// same expected line count/order as that already-verified test).
const base: DigestInput = {
  intervalSec: 600,
  lastFinished: { tickTs: new Date('2026-09-07T12:00:00Z'), finishedAt: new Date('2026-09-07T12:01:30Z'), poolsWritten: 20, poolsFailed: 0, providerCalls: 210, discovered: false },
  ticksLast24h: 70, discoveryCallsToday: 5_691, refreshCallsToday: 9_309, lastDiscoveryAt: new Date('2026-09-07T00:10:00Z'), poolFailures24h: 0, venueErrors24h: 0, unfinishedRuns: 0,
  venuesConfigured: ['MinswapV2', 'SundaeSwapV3'], venuesSinceLastDiscovery: ['MinswapV2', 'SundaeSwapV3'], venuesInLastTick: ['MinswapV2', 'SundaeSwapV3'], tokensTotal: 20, tokensCoveredInLastTick: 20,
};

const now = new Date('2026-09-07T12:05:00Z');

const checksAllOk: Check[] = [
  { name: 'collector processes', status: 'ok', detail: '1 running (pid 111)' },
  { name: 'paper processes', status: 'ok', detail: 'none running' },
  { name: 'migrations', status: 'ok', detail: '6 applied, none pending' },
  { name: 'rehearsal data', status: 'ok', detail: 'no Fake rows' },
];

describe('renderHealth', () => {
  it('renders one row per digest line, in order, with the label and rest split apart', () => {
    const digest = digestLines(base, now);
    expect(digest).toHaveLength(7);
    const html = renderHealth({ digest, checks: checksAllOk, now });
    for (const line of digest) {
      const idx = line.indexOf(': ');
      const label = idx === -1 ? line : line.slice(0, idx);
      expect(html).toContain(`<td>${label}</td>`);
    }
    // seven digest rows in the Digest table specifically
    const digestSection = html.slice(html.indexOf('<h2>Digest'), html.indexOf('<h2>Checks'));
    expect((digestSection.match(/<tr>/g) ?? []).length).toBe(8); // 1 header row + 7 data rows
  });

  it('shows OK on the quota row for a healthy projection', () => {
    const digest = digestLines(base, now);
    const html = renderHealth({ digest, checks: checksAllOk, now });
    const quotaRow = html.split('<tr>').find((r) => r.startsWith('<td>calls since 00:00 UTC</td>'));
    expect(quotaRow).toBeDefined();
    expect(quotaRow).toContain('>OK<');
    expect(quotaRow).toContain('status-ok');
  });

  // Finding: the badge is now derived ONLY from checkDigestLines' own Check.status (never re-derived
  // by regexing the digest line's text), so a STOP-level quota projection shows the check's actual
  // status word FAIL, not a re-derived literal "STOP" — checkDigestLines maps "quota: STOP" to
  // status 'fail'. The word "STOP" itself is not lost: it is still right there in the adjacent detail
  // cell, in the digest line's own unmodified text.
  it('shows FAIL (checkDigestLines\' own verdict) on the quota row when the projection exceeds the daily quota, with STOP still visible in the detail text', () => {
    const digest = digestLines({ ...base, discoveryCallsToday: 6_000, refreshCallsToday: 23_000 }, now);
    const html = renderHealth({ digest, checks: checksAllOk, now });
    const quotaRow = html.split('<tr>').find((r) => r.startsWith('<td>calls since 00:00 UTC</td>'));
    expect(quotaRow).toBeDefined();
    expect(quotaRow).toContain('>FAIL<');
    expect(quotaRow).toContain('status-fail');
    expect(quotaRow).toContain('quota: STOP');
  });

  // Same fix: a STALE collector tick maps to checkDigestLines' 'warn' status, so the badge reads WARN,
  // not a re-derived literal "STALE" — the word "STALE" is still visible in the detail cell's own text.
  it('renders a LOST venues line with LOST in its text, and shows WARN (checkDigestLines\' own verdict) on the collector row, with STALE still visible in the detail text', () => {
    const lostInput: DigestInput = {
      ...base,
      venuesConfigured: ['MinswapV2', 'MuesliSwap', 'SundaeSwapV3'],
      venuesSinceLastDiscovery: ['MuesliSwap', 'SundaeSwapV3'],
      venuesInLastTick: ['SundaeSwapV3'],
      tokensCoveredInLastTick: 16,
    };
    const digest = digestLines(lostInput, now);
    const html = renderHealth({ digest, checks: checksAllOk, now });
    expect(html).toContain('<td>venues LOST since the last discovery</td>');
    expect(html).toContain('MinswapV2');

    const staleNow = new Date('2026-09-07T12:22:00Z'); // > 2 * 600s since the 12:01:30 finish
    const staleDigest = digestLines(base, staleNow);
    const staleHtml = renderHealth({ digest: staleDigest, checks: checksAllOk, now: staleNow });
    const collectorRow = staleHtml.split('<tr>').find((r) => r.startsWith('<td>collector</td>'));
    expect(collectorRow).toBeDefined();
    expect(collectorRow).toContain('>WARN<');
    expect(collectorRow).toContain('status-warn');
    expect(collectorRow).toContain('STALE');
  });

  it('gives every other digest row (not collector/quota) no status word cell content', () => {
    const digest = digestLines(base, now);
    const html = renderHealth({ digest, checks: checksAllOk, now });
    const ticksRow = html.split('<tr>').find((r) => r.startsWith('<td>ticks last 24h</td>'));
    expect(ticksRow).toBeDefined();
    // third <td> in the row is empty: no <span class="status ...">
    expect(ticksRow).not.toContain('class="status');
  });

  it('renders the checks table with FAIL for two collector processes running', () => {
    const digest = digestLines(base, now);
    const checks: Check[] = [
      { name: 'collector processes', status: 'fail', detail: '2 running (pids 111, 222); stop all but one: pkill -TERM -f \'main.ts collect\'' },
      { name: 'paper processes', status: 'ok', detail: 'none running' },
      { name: 'migrations', status: 'ok', detail: '6 applied, none pending' },
      { name: 'rehearsal data', status: 'ok', detail: 'no Fake rows' },
    ];
    const html = renderHealth({ digest, checks, now });
    const checksRow = html.split('<tr>').find((r) => r.startsWith('<td>collector processes</td>'));
    expect(checksRow).toBeDefined();
    expect(checksRow).toContain('>FAIL<');
    expect(checksRow).toContain('status-fail');
  });

  it('includes the 60s refresh meta tag via layout()', () => {
    const digest = digestLines(base, now);
    const html = renderHealth({ digest, checks: checksAllOk, now });
    expect(html).toContain('<meta http-equiv="refresh" content="60">');
  });

  it('never renders a process.env value — it never reads process.env at all', () => {
    const originalKey = process.env.BLOCKFROST_PROJECT_ID;
    const originalDbUrl = process.env.DATABASE_URL;
    process.env.BLOCKFROST_PROJECT_ID = 'SECRETVALUE';
    process.env.DATABASE_URL = 'postgres://u:SECRETPASS@h/d';
    try {
      const digest = digestLines(base, now);
      const html = renderHealth({ digest, checks: checksAllOk, now });
      expect(html).not.toContain('SECRETVALUE');
      expect(html).not.toContain('SECRETPASS');
    } finally {
      if (originalKey === undefined) delete process.env.BLOCKFROST_PROJECT_ID; else process.env.BLOCKFROST_PROJECT_ID = originalKey;
      if (originalDbUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDbUrl;
    }
  });
});
