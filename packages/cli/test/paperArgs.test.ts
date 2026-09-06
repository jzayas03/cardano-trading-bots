import { describe, expect, it } from 'vitest';
import type { RunRow } from '@ctb/engine';
import { paramsMismatch, parsePaperArgs, resumeStatusError } from '../src/commands/paper.js';

describe('parsePaperArgs', () => {
  // Findings I2 and M5 changed two of these defaults from a VALUE to null. `cashAda` and
  // `intervalSec` now mean "not given", which is what lets `--resume` refuse a `--cash-ada` that
  // would silently do nothing, and lets the interval default to the collector's own
  // COLLECT_INTERVAL_SECONDS instead of a hard-coded 300 unrelated to it. The parser no longer
  // decides either value; `resolveIntervalSec`/`DEFAULT_CASH_ADA` do, where the config is in scope.
  it('leaves cashAda and intervalSec unset, and defaults the rest', () => {
    const a = parsePaperArgs(['ma-crossover', 'SNEK']);
    expect(a).toEqual({
      strategyId: 'ma-crossover', ticker: 'SNEK', cashAda: null, resume: null,
      intervalSec: null, allowIntervalMismatch: false, graceSec: 60, maxGapMin: 15,
      rehearsal: false, params: {}, maxTickFailures: 12,
    });
  });

  it('records an explicit --cash-ada and --interval-sec, including 0 ADA', () => {
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--cash-ada', '5000']).cashAda).toBe(5000);
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--cash-ada', '0']).cashAda).toBe(0);
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--interval-sec', '60']).intervalSec).toBe(60);
  });

  it('parses --allow-interval-mismatch', () => {
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--allow-interval-mismatch']).allowIntervalMismatch).toBe(true);
  });

  it('parses --resume', () => {
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--resume', '12']).resume).toBe(12);
  });

  it('parses --rehearsal', () => {
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--rehearsal']).rehearsal).toBe(true);
  });

  it('rejects --interval-sec below 60', () => {
    expect(() => parsePaperArgs(['ma-crossover', 'SNEK', '--interval-sec', '10'])).toThrow(/--interval-sec needs a number >= 60/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parsePaperArgs(['ma-crossover', 'SNEK', '--bogus'])).toThrow(/unknown flag --bogus/);
  });

  it('rejects an empty --param value', () => {
    expect(() => parsePaperArgs(['ma-crossover', 'SNEK', '--param', ''])).toThrow(/--param needs key=numeric value/);
    expect(() => parsePaperArgs(['ma-crossover', 'SNEK', '--param'])).toThrow(/--param needs key=numeric value/);
  });

  it('parses --param key=value pairs', () => {
    expect(parsePaperArgs(['ma-crossover', 'SNEK', '--param', 'fast=6']).params).toEqual({ fast: 6 });
  });
});

/**
 * Finding F2: `--resume` restored a prior run's cash/position but never checked whether the strategy
 * params it's about to run with are the ones the prior run was started with — a resumed run silently
 * splicing a different `slow`/`fast` etc. onto an equity curve started under the old ones. `current` is
 * `{ ...strategy.defaultParams, ...a.params }` (the same merge `runEngine` itself does); `prior` is the
 * jsonb `runs.params` blob, which flattens strategy params at the top level next to `cashAda`/`maxGapMs`
 * (see `buildRunParams`) — so this compares `current`'s own keys against that same top level.
 */
describe('paramsMismatch', () => {
  it('returns null when every key present in prior matches current', () => {
    expect(paramsMismatch({ fast: 6, slow: 20, cashAda: 1000 }, { fast: 6, slow: 20 })).toBeNull();
  });

  it('names the mismatched key and both values', () => {
    const msg = paramsMismatch({ fast: 6, slow: 20 }, { fast: 6, slow: 25 });
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/slow/);
    expect(msg).toContain('20');
    expect(msg).toContain('25');
  });

  it('ignores a current key the prior run never recorded', () => {
    expect(paramsMismatch({ fast: 6 }, { fast: 6, slow: 25 })).toBeNull();
  });

  it('compares numerically: a jsonb string value equal in number to current is not a mismatch', () => {
    expect(paramsMismatch({ fast: '6' }, { fast: 6 })).toBeNull();
  });
});

/**
 * Task 6 rehearsal defect: the Step-3 stop/resume cycle (`kill -INT`, then `--resume <run-id>`)
 * failed for real against a live database with `run 6 is finished; start a new run` — the ONLY
 * status a signal-stopped paper run ever has, since `liveCandleFeed` never returns on its own. No
 * test caught this before because nothing exercised `paperCommand`'s resume branch end to end.
 *
 * Final-review finding C2 changes this rule's SHAPE, not just its verdict, so these tests changed
 * with it: a process killed without its catch block (`kill -9`, an OOM, a lost machine) leaves
 * `status = 'running'` forever, and refusing every `'running'` row made that run permanently
 * unresumable — the operator's only recovery was hand-editing the row. The rule is now "refuse a
 * run that is DEMONSTRABLY still alive", where liveness is the same heartbeat bound `status` prints
 * (`isHeartbeatStale`), so `resumeStatusError` takes the run row and a clock instead of a bare
 * status. A live second writer is still refused — that hazard (two processes racing
 * `paper_orders.seq` on one `run_id`) is unchanged.
 */
describe('resumeStatusError', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');
  const run = (over: Partial<Pick<RunRow, 'status' | 'heartbeatAt' | 'params'>>): Pick<RunRow, 'status' | 'heartbeatAt' | 'params'> => ({
    status: 'finished', heartbeatAt: null, params: { intervalSec: 60, graceSec: 5 }, ...over,
  });

  it('allows resuming a finished run (the normal outcome of a clean SIGINT stop)', () => {
    expect(resumeStatusError(run({ status: 'finished' }), now)).toBeNull();
  });

  it('allows resuming an aborted run (recovering after a crash the catch block did reach)', () => {
    expect(resumeStatusError(run({ status: 'aborted' }), now)).toBeNull();
  });

  it('refuses a running run whose heartbeat is fresh, to avoid two writers on one run_id', () => {
    const fresh = new Date(now.getTime() - 30_000); // bound is 2*60 + 5 = 125s
    expect(resumeStatusError(run({ status: 'running', heartbeatAt: fresh }), now)).toMatch(/already running/);
  });

  it('allows a running run whose heartbeat is stale — the kill -9 recovery path (finding C2)', () => {
    const stale = new Date(now.getTime() - 600_000);
    expect(resumeStatusError(run({ status: 'running', heartbeatAt: stale }), now)).toBeNull();
  });

  it('allows a running run that never heartbeated at all (died before its first tick)', () => {
    expect(resumeStatusError(run({ status: 'running', heartbeatAt: null }), now)).toBeNull();
  });
});
