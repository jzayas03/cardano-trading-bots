/**
 * The one check `doctor` does not make: is each `running` paper run actually being run by something.
 *
 * `doctor` counts paper processes and reports heartbeat ages, but never correlates the two. That
 * correlation is what distinguishes the three states a stale heartbeat can mean, and they need
 * opposite responses:
 *
 *   - the process died and nothing replaced it            -> the run is dead
 *   - the process is alive but has stopped beating        -> the run is wedged
 *   - the process was just resumed and has not yet
 *     reached its first boundary                          -> perfectly healthy
 *
 * The third case is not hypothetical: a run writes its heartbeat at each boundary, so a resumed run
 * carries the DEAD segment's heartbeat and reads stale for up to a whole interval. Measured on
 * 2026-09-08, run 138 resumed at 01:32 and read STALE (1942s) while healthy. An alarm on staleness
 * alone pages on every legitimate recovery, and a monitor that cries wolf gets muted and then
 * ignored — which is the silent failure this whole check exists to prevent.
 */
import type { Check } from './doctor.js';

/** A `running` row, reduced to what the check needs. */
export interface PaperRunState {
  id: number;
  strategyId: string;
  status: string;
  heartbeatAt: Date | null;
}

/** One process, with how long it has been alive. `elapsedSec` is null when `ps` gave nothing usable. */
export interface RunningProcess {
  pid: number;
  command: string;
  elapsedSec: number | null;
}

/**
 * Parses `ps -o etime=`: `[[dd-]hh:]mm:ss`.
 *
 * macOS `ps` does NOT support `etimes` (the seconds-only form Linux has) — asking for it yields an
 * EMPTY column rather than an error, so a parser written against `etimes` silently reads the next
 * field, the command, as its number. `etime` is the portable spelling and this is its parser.
 */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
}

/** The tsx wrapper, not the `--require .../tsx/dist/preflight.cjs` child it spawns: one run is two
 * `ps` entries, and counting both reads one run as two. Same rule `checkProcesses` uses. */
function isWrapper(p: RunningProcess): boolean {
  return !/tsx\/dist\/preflight/.test(p.command);
}

/**
 * Finds the process running a given strategy.
 *
 * Matching is by strategy id because a freshly started run carries no run id on its command line —
 * only a resumed one has `--resume N`. The runbook's rule of one process per strategy is what makes
 * this unambiguous; two runs of the same strategy would need the run id, and the check says so
 * rather than guessing.
 */
export function processFor(strategyId: string, procs: readonly RunningProcess[]): RunningProcess[] {
  const re = new RegExp(`main\\.ts paper (?:--\\S+ \\S+ )*${strategyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
  return procs.filter(isWrapper).filter((p) => re.test(p.command));
}

/**
 * One check per `running` paper run.
 *
 * `intervalSec` is the collector interval the runs are following: a resumed process is given one
 * whole interval to reach its first boundary before its silence counts against it.
 */
export function checkPaperRuns(
  runs: readonly PaperRunState[],
  procs: readonly RunningProcess[],
  now: Date,
  intervalSec: number,
  graceSec = 60,
): Check[] {
  const running = runs.filter((r) => r.status === 'running');
  if (running.length === 0) return [{ name: 'paper runs', status: 'ok', detail: 'no run is marked running' }];

  const staleBoundSec = 2 * intervalSec + graceSec;
  return running.map((r) => {
    const name = `paper run ${r.id} (${r.strategyId})`;
    const mine = processFor(r.strategyId, procs);
    const ageSec = r.heartbeatAt === null ? null : Math.round((now.getTime() - r.heartbeatAt.getTime()) / 1000);

    // A row that says `running` with nothing running it is wrong whatever the heartbeat says, and it
    // is wrong NOW — waiting for the heartbeat to go stale would delay this by a whole stale bound
    // (31 minutes at a 900-second interval) for no gain.
    if (mine.length === 0) {
      return { name, status: 'fail', detail: `marked running but no process is running it; resume it with --resume ${r.id}` };
    }
    if (mine.length > 1) {
      return { name, status: 'fail', detail: `${mine.length} processes match this strategy (pids ${mine.map((p) => p.pid).join(', ')}); two writers race paper_orders.seq` };
    }
    if (ageSec === null || ageSec <= staleBoundSec) {
      return { name, status: 'ok', detail: ageSec === null ? `alive (pid ${mine[0]!.pid}), no heartbeat yet` : `alive (pid ${mine[0]!.pid}), heartbeat ${ageSec}s` };
    }

    // Stale, but a process IS running it. Young enough to be a fresh resume that has not reached a
    // boundary yet, or old enough that it should have beaten by now and has not.
    const procAge = mine[0]!.elapsedSec;
    if (procAge !== null && procAge < intervalSec) {
      return { name, status: 'ok', detail: `heartbeat ${ageSec}s but its process is only ${procAge}s old — resumed, not yet at a boundary` };
    }
    return {
      name, status: 'fail',
      detail: `heartbeat ${ageSec}s (bound ${staleBoundSec}s) and its process (pid ${mine[0]!.pid}) has been up ${procAge === null ? 'an unknown time' : `${procAge}s`}; it is running but not working`,
    };
  });
}
