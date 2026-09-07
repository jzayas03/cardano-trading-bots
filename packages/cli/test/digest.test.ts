import { describe, expect, it } from 'vitest';
import { BLOCKFROST_FREE_DAILY_QUOTA, digestLines, type DigestInput, utcMidnight } from '../src/digest.js';

const base: DigestInput = {
  intervalSec: 600,
  lastFinished: { tickTs: new Date('2026-09-07T12:00:00Z'), finishedAt: new Date('2026-09-07T12:01:30Z'), poolsWritten: 20, poolsFailed: 0, providerCalls: 210, discovered: false },
  ticksLast24h: 70, discoveryCallsToday: 5_691, refreshCallsToday: 9_309, lastDiscoveryAt: new Date('2026-09-07T00:10:00Z'), poolFailures24h: 0, venueErrors24h: 0, unfinishedRuns: 0,
  venuesConfigured: ['MinswapV2', 'SundaeSwapV3'], venuesInLastDiscovery: ['MinswapV2', 'SundaeSwapV3'], venuesInLastTick: ['MinswapV2', 'SundaeSwapV3'], tokensTotal: 20, tokensCoveredInLastTick: 20,
};

describe('digestLines', () => {
  it('reads a healthy mid-day collector as OK with a day projection from the UTC-midnight elapsed time', () => {
    const now = new Date('2026-09-07T12:05:00Z'); // 12h05 elapsed -> 5691 + 9309 refresh * 86400/43500 = 5691 + 18490 = 24181
    const lines = digestLines(base, now);
    expect(lines[0]).toBe('collector: last tick 2026-09-07T12:00:00.000Z finished 4m ago | 20 pools written, 0 failed, 210 calls');
    expect(lines[1]).toBe('ticks last 24h: 70 of 144 expected at 600s (74 missing)');
    expect(lines[2]).toBe(`calls since 00:00 UTC: 15000 (5691 discovery + 9309 refresh over 12.1h) -> projected 24181/day of ${BLOCKFROST_FREE_DAILY_QUOTA} (48%) | quota: OK`);
    expect(lines[3]).toBe('venues found at the last discovery: all 2 configured');
    expect(lines[4]).toBe('tokens covered in the newest tick: 20 of 20');
    expect(lines[5]).toBe('last discovery: 2026-09-07T00:10:00.000Z (11.9h ago)');
    expect(lines[6]).toBe('last 24h: 0 pool failures, 0 venue errors, 0 unfinished runs');
  });
  it('says WATCH above 40k and STOP above the quota, with the stop command', () => {
    const now = new Date('2026-09-07T12:00:00Z'); // refresh rate x2 over the day
    expect(digestLines({ ...base, discoveryCallsToday: 6_000, refreshCallsToday: 18_000 }, now)[2]).toMatch(/projected 42000\/day .* quota: WATCH$/);
    expect(digestLines({ ...base, discoveryCallsToday: 6_000, refreshCallsToday: 23_000 }, now)[2]).toMatch(/projected 52000\/day .* quota: STOP the collector \(pkill -TERM -f 'main.ts collect'\)$/);
  });
  it('projects only the refresh half over the day: a discovery at 00:13 is paid once, not 155k times', () => {
    // The first real digest (01:17 UTC, 8386 calls of which ~8300 discovery) projected 155693/day and said STOP.
    const now = new Date('2026-09-07T01:17:00Z');
    expect(digestLines({ ...base, discoveryCallsToday: 8_096, refreshCallsToday: 290 }, now)[2]).toBe(`calls since 00:00 UTC: 8386 (8096 discovery + 290 refresh over 1.3h) -> projected ${8_096 + Math.round((290 / 4620) * 86_400)}/day of ${BLOCKFROST_FREE_DAILY_QUOTA} (27%) | quota: OK`);
  });
  it('tells a venue LOST at discovery apart from one PRUNED by the deepest policy, and counts tokens left without a pool (the live run lost MinswapV2 at 00:20 UTC)', () => {
    const now = new Date('2026-09-07T12:05:00Z');
    const lines = digestLines({ ...base, venuesConfigured: ['MinswapV2', 'MuesliSwap', 'SundaeSwapV3'], venuesInLastDiscovery: ['MuesliSwap', 'SundaeSwapV3'], venuesInLastTick: ['SundaeSwapV3'], tokensCoveredInLastTick: 16 }, now);
    expect(lines[3]).toBe('venues LOST at the last discovery: MinswapV2 (configured: MinswapV2, MuesliSwap, SundaeSwapV3) — a venue that returned no pools stays out until the next discovery; restart the collector to rediscover now');
    expect(lines[4]).toBe('venues found but not refreshed (deepest for no token): MuesliSwap');
    expect(lines[5]).toBe('tokens with NO pool in the newest tick: 4 of 20 — those tokens have no candles until a discovery finds them a pool');
    // no pruned line when nothing was pruned: the line count shrinks by one
    expect(digestLines(base, now)).toHaveLength(7);
    expect(lines).toHaveLength(8);
  });
  it('refuses to project in the first 30 minutes of the UTC day (one discovery tick would read as 600k/day)', () => {
    const now = new Date('2026-09-07T00:20:00Z');
    expect(digestLines({ ...base, discoveryCallsToday: 5_691, refreshCallsToday: 0 }, now)[2]).toBe('calls since 00:00 UTC: 5691 (5691 discovery + 0 refresh) over 20m — too early to project a day (needs 30m); check the Blockfrost dashboard');
    // and at exactly zero elapsed there is no division at all
    expect(digestLines(base, new Date('2026-09-07T00:00:00Z'))[2]).toMatch(/too early/);
  });
  it('marks the collector STALE past two intervals since the last finished tick, and handles no tick at all', () => {
    const now = new Date('2026-09-07T12:22:00Z'); // 20.5 min since 12:01:30 > 2*600s
    expect(digestLines(base, now)[0]).toMatch(/^collector: STALE — last tick/);
    expect(digestLines({ ...base, lastFinished: null, lastDiscoveryAt: null }, now)[0]).toBe('collector: no finished tick on record');
    expect(digestLines({ ...base, lastFinished: null, lastDiscoveryAt: null }, now)[5]).toBe('last discovery: never');
  });
  it('labels a discovery tick and counts unfinished runs with the in-flight caveat', () => {
    const now = new Date('2026-09-07T12:05:00Z');
    expect(digestLines({ ...base, lastFinished: { ...base.lastFinished!, discovered: true, providerCalls: 5691 } }, now)[0]).toMatch(/5691 calls \(discovery\)$/);
    expect(digestLines({ ...base, unfinishedRuns: 1, poolFailures24h: 3, venueErrors24h: 2 }, now)[6]).toBe('last 24h: 3 pool failures, 2 venue errors, 1 unfinished run (the newest may be in flight)');
  });
  it('utcMidnight floors to the UTC day, not the local one', () => {
    expect(utcMidnight(new Date('2026-09-07T23:59:59.999Z')).toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(utcMidnight(new Date('2026-09-08T00:00:00.000Z')).toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });
});
