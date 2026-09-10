import { describe, expect, it } from 'vitest';
import {
  afterDeployChecks, afterStopChecks, beforeStopChecks, MAX_BACKUP_AGE_HOURS,
  type AfterDeployFacts, type AfterStopFacts, type BeforeStopFacts, type Check,
} from '../src/index.js';

const before = (o: Partial<BeforeStopFacts> = {}): BeforeStopFacts => ({
  backupAgeHours: 4, expectedRunIds: [146, 147, 148], runningRunIds: [146, 147, 148],
  gitDirtyFiles: 0, deployedSha: 'aaaaaaa', expectedSha: 'aaaaaaa', ...o,
});
const afterStop = (o: Partial<AfterStopFacts> = {}): AfterStopFacts => ({
  runningRunIds: [], unfinishedRunIds: [], collectorProcesses: 0,
  newestHeartbeatAgeSec: 4000, intervalSec: 600, ...o,
});
const afterDeploy = (o: Partial<AfterDeployFacts> = {}): AfterDeployFacts => ({
  deployedSha: 'bbbbbbb', expectedSha: 'bbbbbbb', migrationsApplied: 9, migrationFiles: 9,
  servicesActive: { 'ctb-collector': true }, multiVenueEveryNTicks: 4, ticksSinceRestart: 2, ...o,
});
const named = (cs: Check[], n: string): Check => cs.find((c) => c.name === n)!;
const fails = (cs: Check[]): number => cs.filter((c) => c.status === 'fail').length;

describe('cutover — before stopping the runs', () => {
  it('passes a clean starting state, and reports every check, not only failures', () => {
    const cs = beforeStopChecks(before());
    expect(fails(cs)).toBe(0);
    expect(cs.map((c) => c.name)).toEqual(['backup', 'runs alive', 'worktree clean', 'deployed sha']);
  });

  it('refuses to start without a recent backup — this step is the one that is not reversible', () => {
    expect(MAX_BACKUP_AGE_HOURS).toBe(26);
    expect(named(beforeStopChecks(before({ backupAgeHours: 30 })), 'backup').status).toBe('fail');
    // An unknown age is NOT a pass. A check that could not run is not a verdict.
    expect(named(beforeStopChecks(before({ backupAgeHours: null })), 'backup').status).toBe('fail');
  });

  it('fails when the runs it is about to stop are not the runs it expected', () => {
    expect(named(beforeStopChecks(before({ runningRunIds: [146, 147] })), 'runs alive').status).toBe('fail');
    expect(named(beforeStopChecks(before({ runningRunIds: [146, 147, 148, 149] })), 'runs alive').status).toBe('fail');
  });

  it('fails on a dirty worktree, because tracked files are never edited on the server', () => {
    expect(named(beforeStopChecks(before({ gitDirtyFiles: 2 })), 'worktree clean').status).toBe('fail');
    expect(named(beforeStopChecks(before({ gitDirtyFiles: null })), 'worktree clean').status).toBe('fail');
  });
});

describe('cutover — after stopping the runs', () => {
  it('passes only when NOTHING is left running', () => {
    const cs = afterStopChecks(afterStop());
    expect(fails(cs)).toBe(0);
    expect(cs.map((c) => c.name)).toEqual(['no running rows', 'runs finished', 'collector stopped', 'heartbeats stale']);
  });

  it('fails on a single row still marked running — the defect this whole phase exists for', () => {
    // `paper-start.sh` RESUMES a row marked running. One row left in that state turns the "clean
    // restart" into a silent continuation of the old run, and the ids look right either way.
    const c = named(afterStopChecks(afterStop({ runningRunIds: [148] })), 'no running rows');
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/148/);
    expect(c.detail).toMatch(/resume/i);
  });

  it('fails when a stopped run never recorded why it stopped', () => {
    expect(named(afterStopChecks(afterStop({ unfinishedRunIds: [147] })), 'runs finished').status).toBe('fail');
  });

  it('treats an uncountable process table as someone still being there', () => {
    expect(named(afterStopChecks(afterStop({ collectorProcesses: null })), 'collector stopped').status).toBe('fail');
    expect(named(afterStopChecks(afterStop({ collectorProcesses: 1 })), 'collector stopped').status).toBe('fail');
  });

  it('wants the heartbeat STALE here, which is the opposite of every other check in this repo', () => {
    // A fresh heartbeat after the stop means a writer is still alive. Bound is the same 2*interval
    // + grace the resume path uses, so the two cannot drift into disagreeing.
    expect(named(afterStopChecks(afterStop({ newestHeartbeatAgeSec: 30 })), 'heartbeats stale').status).toBe('fail');
    expect(named(afterStopChecks(afterStop({ newestHeartbeatAgeSec: null })), 'heartbeats stale').status).toBe('fail');
  });
});

describe('cutover — after deploying', () => {
  it('passes a complete deploy', () => {
    expect(fails(afterDeployChecks(afterDeploy()))).toBe(0);
  });

  it('fails when the deployed commit is not the one intended', () => {
    expect(named(afterDeployChecks(afterDeploy({ deployedSha: 'ccccccc' })), 'deployed sha').status).toBe('fail');
  });

  it('refuses to compare HEAD with itself when no expectation was supplied', () => {
    // Defaulting the expectation to the local HEAD made this check pass while asserting NOTHING --
    // the same shape as the registry test that passed against `undefined` earlier today.
    for (const expectedSha of [null, '']) {
      const c = named(afterDeployChecks(afterDeploy({ expectedSha })), 'deployed sha');
      expect(c.status).toBe('fail');
      expect(c.detail).toMatch(/--expect-sha/);
    }
    expect(named(beforeStopChecks(before({ expectedSha: null })), 'deployed sha').status).toBe('fail');
  });

  it('fails on a pending migration rather than letting the collector start against old schema', () => {
    const c = named(afterDeployChecks(afterDeploy({ migrationsApplied: 7, migrationFiles: 9 })), 'migrations');
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/2 pending/);
    // More applied than files is not "fine": it means this checkout is BEHIND the database.
    expect(named(afterDeployChecks(afterDeploy({ migrationsApplied: 11 })), 'migrations').status).toBe('fail');
  });

  it('fails on any inactive service, naming it', () => {
    const c = named(afterDeployChecks(afterDeploy({ servicesActive: { 'ctb-collector': true, 'ctb-watch.timer': false } })), 'services');
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/ctb-watch\.timer/);
    expect(named(afterDeployChecks(afterDeploy({ servicesActive: {} })), 'services').status).toBe('fail');
  });

  it('checks multi-venue sampling is ON, since after the run is exactly when it should be', () => {
    expect(named(afterDeployChecks(afterDeploy({ multiVenueEveryNTicks: null })), 'multi-venue').status).toBe('fail');
    expect(named(afterDeployChecks(afterDeploy({ multiVenueEveryNTicks: 0 })), 'multi-venue').status).toBe('fail');
  });

  it('fails until the collector has actually ticked, not merely started', () => {
    // A unit that is `active` has been launched. It has not necessarily done anything, and this
    // project has a history of green deploy jobs that deployed nothing.
    expect(named(afterDeployChecks(afterDeploy({ ticksSinceRestart: 0 })), 'collector ticking').status).toBe('fail');
    expect(named(afterDeployChecks(afterDeploy({ ticksSinceRestart: null })), 'collector ticking').status).toBe('fail');
  });
});
