import { describe, expect, it } from 'vitest';
import { checkBackupFreshness, checkPaperRuns, parseEtime, processFor, type PaperRunState, type RunningProcess } from '../src/watch.js';

const NOW = new Date('2026-09-08T02:00:00Z');
const INTERVAL = 900; // stale bound = 2*900 + 60 = 1860s

/** THE running CLI: the node child tsx spawns with --require preflight. Exactly one per run. */
function proc(pid: number, strategy: string, elapsedSec: number | null): RunningProcess {
  return { pid, elapsedSec,
    command: `/usr/bin/node --require /r/node_modules/tsx/dist/preflight.cjs --import file:///r/node_modules/tsx/dist/loader.mjs packages/cli/src/main.ts paper ${strategy} NIGHT --max-gap-min 20` };
}
/** The tsx wrapper. Must never be counted — it is the same run. */
function tsxWrapper(pid: number, strategy: string): RunningProcess {
  return { pid, elapsedSec: 100, command: `node /r/node_modules/.bin/tsx packages/cli/src/main.ts paper ${strategy} NIGHT --max-gap-min 20` };
}
/** systemd's outermost link. Also the same run, and the shape that broke the old rule. */
function shWrapper(pid: number, strategy: string): RunningProcess {
  return { pid, elapsedSec: 100, command: `sh -c tsx packages/cli/src/main.ts paper ${strategy} NIGHT --max-gap-min 20` };
}
function run(id: number, strategyId: string, heartbeatAgeSec: number | null, status = 'running'): PaperRunState {
  return { id, strategyId, status, heartbeatAt: heartbeatAgeSec === null ? null : new Date(NOW.getTime() - heartbeatAgeSec * 1000) };
}

describe('parseEtime', () => {
  it('parses every shape ps produces', () => {
    expect(parseEtime('55:56')).toBe(3356);
    expect(parseEtime('01:02:03')).toBe(3723);
    expect(parseEtime('03-07:39:48')).toBe(286788); // 3d + 7h39m48s
    expect(parseEtime('  00:05  ')).toBe(5);
  });

  it('returns null rather than a number for anything it does not understand', () => {
    // macOS ps silently yields an EMPTY column for `etimes`, so the field can arrive as a command
    // string. Returning null keeps that from being read as an age of zero, which would make a
    // wedged process look freshly resumed and therefore healthy.
    for (const bad of ['', '/sbin/launchd', 'node /r/main.ts', '12', 'abc:def']) {
      expect(parseEtime(bad)).toBeNull();
    }
  });
});

describe('processFor', () => {
  it('counts ONE process for a run, whatever the supervisor wrapped it in', () => {
    // The full systemd chain: sh -c -> tsx -> node(preflight). Three ps entries, one run.
    const procs = [shWrapper(1, 'ma-crossover'), tsxWrapper(2, 'ma-crossover'), proc(3, 'ma-crossover', 100)];
    expect(processFor('ma-crossover', procs).map((p) => p.pid)).toEqual([3]);
  });

  it('does not count the systemd sh -c wrapper as a second writer (the M5 regression)', () => {
    // Under launchd, `npm run collect` never matched "main.ts collect" so the old wrapper-counting
    // rule happened to give 1. Under systemd `sh -c tsx ...main.ts...` DOES match, so it gave 2 —
    // every healthy unit read as a double-writer, and --resume would have refused every resume.
    const procs = [shWrapper(1, 'rsi-mean-reversion'), tsxWrapper(2, 'rsi-mean-reversion'), proc(3, 'rsi-mean-reversion', 100)];
    expect(processFor('rsi-mean-reversion', procs)).toHaveLength(1);
  });

  it('does not confuse one strategy for another', () => {
    const procs = [proc(1, 'ma-crossover', 100), proc(2, 'rsi-mean-reversion', 100), proc(3, 'buy-and-hold', 100)];
    expect(processFor('rsi-mean-reversion', procs).map((p) => p.pid)).toEqual([2]);
    expect(processFor('buy-and-hold', procs).map((p) => p.pid)).toEqual([3]);
  });

  it('finds a resumed process, whose argv carries flags before the strategy', () => {
    const p: RunningProcess = { pid: 9, elapsedSec: 10, command: '/usr/bin/node --require /r/node_modules/tsx/dist/preflight.cjs packages/cli/src/main.ts paper rsi-mean-reversion NIGHT --max-gap-min 20 --resume 138' };
    expect(processFor('rsi-mean-reversion', [p]).map((x) => x.pid)).toEqual([9]);
  });
});

describe('checkPaperRuns', () => {
  it('says so plainly when nothing is marked running', () => {
    expect(checkPaperRuns([], [], NOW, INTERVAL)).toEqual([{ name: 'paper runs', status: 'ok', detail: 'no run is marked running' }]);
  });

  it('is ok for a healthy run', () => {
    const c = checkPaperRuns([run(137, 'ma-crossover', 120)], [proc(1, 'ma-crossover', 5000)], NOW, INTERVAL);
    expect(c[0]!.status).toBe('ok');
  });

  it('FAILS immediately when a running row has no process, without waiting for the heartbeat', () => {
    // The crash the day-2 drill produced. Heartbeat is only 120s old — well inside the bound — so a
    // staleness-only monitor would stay silent for another half hour.
    const c = checkPaperRuns([run(138, 'rsi-mean-reversion', 120)], [], NOW, INTERVAL);
    expect(c[0]!.status).toBe('fail');
    expect(c[0]!.detail).toMatch(/no process is running it.*--resume 138/);
  });

  it('FAILS when two processes match one run, because they race paper_orders.seq', () => {
    const c = checkPaperRuns([run(138, 'rsi-mean-reversion', 60)], [proc(1, 'rsi-mean-reversion', 900), proc(2, 'rsi-mean-reversion', 30)], NOW, INTERVAL);
    expect(c[0]!.status).toBe('fail');
    expect(c[0]!.detail).toMatch(/2 processes match/);
  });

  it('is OK for a stale heartbeat whose process was only just resumed', () => {
    // The false alarm this check exists to avoid: run 138 resumed at 01:32 carrying the dead
    // segment's 01:00 heartbeat, and read STALE (1942s) while perfectly healthy.
    const c = checkPaperRuns([run(138, 'rsi-mean-reversion', 1942)], [proc(1, 'rsi-mean-reversion', 120)], NOW, INTERVAL);
    expect(c[0]!.status).toBe('ok');
    expect(c[0]!.detail).toMatch(/resumed, not yet at a boundary/);
  });

  it('FAILS for a stale heartbeat whose process has been up longer than an interval', () => {
    // Alive but not working — a wedged process, which staleness alone cannot tell from a resume.
    const c = checkPaperRuns([run(138, 'rsi-mean-reversion', 1942)], [proc(1, 'rsi-mean-reversion', 4000)], NOW, INTERVAL);
    expect(c[0]!.status).toBe('fail');
    expect(c[0]!.detail).toMatch(/running but not working/);
  });

  it('treats an unknown process age as not-an-excuse', () => {
    // elapsedSec null must not read as "young, therefore fine".
    const c = checkPaperRuns([run(138, 'rsi-mean-reversion', 1942)], [proc(1, 'rsi-mean-reversion', null)], NOW, INTERVAL);
    expect(c[0]!.status).toBe('fail');
  });

  it('ignores runs that are not running', () => {
    const c = checkPaperRuns([run(1, 'ma-crossover', 99999, 'finished'), run(2, 'buy-and-hold', 60)], [proc(7, 'buy-and-hold', 5000)], NOW, INTERVAL);
    expect(c).toHaveLength(1);
    expect(c[0]!.name).toMatch(/run 2/);
  });

  it('scales the bound with the interval rather than hardcoding 15 minutes', () => {
    const at600 = checkPaperRuns([run(1, 'x', 1300)], [proc(1, 'x', 9000)], NOW, 600);   // bound 1260 -> stale
    const at900 = checkPaperRuns([run(1, 'x', 1300)], [proc(1, 'x', 9000)], NOW, 900);   // bound 1860 -> fine
    expect(at600[0]!.status).toBe('fail');
    expect(at900[0]!.status).toBe('ok');
  });
});

describe('checkBackupFreshness', () => {
  it('is ok for a backup taken today', () => {
    expect(checkBackupFreshness(3).status).toBe('ok');
  });

  it('warns before it fails, so a slipping schedule is visible before it is broken', () => {
    expect(checkBackupFreshness(27).status).toBe('warn');
    expect(checkBackupFreshness(49).status).toBe('fail');
  });

  it('FAILS when there has never been a backup — an absence is not a pass', () => {
    // The shape this guards against: a directory that is empty because the schedule never once
    // fired reads exactly like a directory nobody has looked at.
    const c = checkBackupFreshness(null);
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/no backup has ever been taken/);
  });

  it('names where to look when the schedule has stopped', () => {
    expect(checkBackupFreshness(72).detail).toMatch(/scheduled-backup\.log/);
  });

  it('scales with the thresholds it is given rather than hardcoding a day', () => {
    expect(checkBackupFreshness(10, 8, 12).status).toBe('warn');
    expect(checkBackupFreshness(13, 8, 12).status).toBe('fail');
  });
});
