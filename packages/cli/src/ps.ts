import { execFileSync } from 'node:child_process';
import { parseEtime, type RunningProcess } from '@ctb/reports';

/**
 * Every process, with how long it has been alive.
 *
 * Returns null rather than throwing when `ps` cannot be read. Both callers must treat an unreadable
 * process table as "someone might be there", never as "nobody is there", and a null is harder to
 * mistake for an empty list than an empty list is.
 */
export function listProcessesWithAge(): RunningProcess[] | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null; // intentional: an unreadable ps is an unknown, and callers fail closed on unknowns
  }
  return out.split('\n').map((l) => l.trim()).filter(Boolean).flatMap((l) => {
    const m = /^(\d+)\s+(\S+)\s+(.*)$/.exec(l);
    if (!m) return [];
    return [{ pid: Number(m[1]), elapsedSec: parseEtime(m[2]!), command: m[3]! }];
  });
}

/**
 * The pids belonging to THIS invocation, which must never be counted as a competing writer.
 *
 * A resuming process is itself `main.ts paper <strategy> ... --resume N`, so a scan that does not
 * exclude it matches its own tsx wrapper and the run refuses itself — every resume would fail
 * closed, which is safe but useless. `process.ppid` is that wrapper: npm spawns the tsx wrapper,
 * which spawns this node child.
 */
export function ownPids(): ReadonlySet<number> {
  return new Set([process.pid, process.ppid]);
}
