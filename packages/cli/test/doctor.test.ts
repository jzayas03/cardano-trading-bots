import { describe, expect, it } from 'vitest';
import { checkDigestLines, checkDisk, checkEnv, checkFakeRows, checkMigrations, checkNode, checkProcesses, verdict } from '../src/doctor.js';

describe('doctor checks', () => {
  it('node: passes at or above .nvmrc, fails below, warns on an unreadable .nvmrc', () => {
    expect(checkNode('v24.14.0', '24\n').status).toBe('ok');
    expect(checkNode('v22.1.0', '24')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/below .nvmrc 24/) });
    expect(checkNode('v24.0.0', '').status).toBe('warn');
  });
  it('env: key reported by length only, never by value; stale interval is a warn naming both numbers', () => {
    const checks = checkEnv({ DATABASE_URL: 'postgres://u:p@localhost:5433/ctb', BLOCKFROST_PROJECT_ID: 'mainnetSECRETSECRET', COLLECT_INTERVAL_SECONDS: '300' });
    const key = checks.find((c) => c.name === 'BLOCKFROST_PROJECT_ID')!;
    expect(key.status).toBe('ok');
    expect(key.detail).toContain('19 chars');
    expect(JSON.stringify(checks)).not.toContain('SECRET');
    expect(checks.find((c) => c.name === 'DATABASE_URL')!.detail).toBe('set (host localhost)');
    expect(JSON.stringify(checks)).not.toContain(':p@');
    expect(checks.find((c) => c.name === 'COLLECT_INTERVAL_SECONDS')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/sets 300 s, overriding the 600 s default/) });
  });
  it('env: missing url fails, blank key warns, unset or default interval is ok', () => {
    const checks = checkEnv({ BLOCKFROST_PROJECT_ID: '' });
    expect(checks.find((c) => c.name === 'DATABASE_URL')!.status).toBe('fail');
    expect(checks.find((c) => c.name === 'BLOCKFROST_PROJECT_ID')!.status).toBe('warn');
    expect(checks.find((c) => c.name === 'COLLECT_INTERVAL_SECONDS')!.status).toBe('ok');
    expect(checkEnv({ DATABASE_URL: 'x', COLLECT_INTERVAL_SECONDS: '600' }).find((c) => c.name === 'COLLECT_INTERVAL_SECONDS')!.status).toBe('ok');
  });
  it('processes: one run is ONE however its supervisor wraps it; two runs fail with the stop command', () => {
    // The node child with --require preflight IS the running CLI: exactly one per run under both
    // supervisors. Counting wrappers instead was not portable —
    //   launchd: `npm run collect` -> tsx -> preflight   (npm's argv does not match, so 1)
    //   systemd: `sh -c tsx ...collect` -> tsx -> preflight (sh's argv DOES match, so 2)
    // On the M5 host that read every healthy unit as a duplicate. Found 2026-09-08.
    const collectorRun = (wrapperPid: number, tsxPid: number, nodePid: number) => [
      { pid: wrapperPid, command: 'sh -c tsx packages/cli/src/main.ts collect' },
      { pid: tsxPid, command: 'node /x/node_modules/.bin/tsx packages/cli/src/main.ts collect' },
      { pid: nodePid, command: '/x/bin/node --require /x/node_modules/tsx/dist/preflight.cjs --import file:///x/node_modules/tsx/dist/loader.mjs packages/cli/src/main.ts collect' },
    ];
    const paperNode = { pid: 13, command: '/x/bin/node --require /x/node_modules/tsx/dist/preflight.cjs packages/cli/src/main.ts paper ma-crossover SNEK' };
    const lines = [
      ...collectorRun(10, 11, 20),
      ...collectorRun(30, 31, 21),
      { pid: 12, command: 'node tsx packages/cli/src/main.ts collector-lookalike' },
      paperNode,
      { pid: 99, command: 'node tsx packages/cli/src/main.ts doctor' },
    ];
    const two = checkProcesses(lines, 99);
    expect(two.find((c) => c.name === 'collector processes')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/2 running \(pids 20, 21\).*pkill -TERM/) });
    expect(two.find((c) => c.name === 'paper processes')!.detail).toBe('1 running (pids 13)');

    // ONE collector, wrapped in all three layers, must read as one — not three.
    const one = checkProcesses([...collectorRun(10, 11, 20), paperNode, { pid: 99, command: 'x' }], 99);
    expect(one.find((c) => c.name === 'collector processes')).toMatchObject({ status: 'ok', detail: '1 running (pid 20)' });

    // Wrappers with no preflight child at all: a run that is not really running yet.
    expect(checkProcesses([{ pid: 5, command: 'sh -c tsx packages/cli/src/main.ts collect' }], 1)
      .find((c) => c.name === 'collector processes')!.detail).toBe('none running');
    expect(checkProcesses([{ pid: 5, command: 'tsx packages/cli/src/main.ts collect' }], 5)
      .find((c) => c.name === 'collector processes')!.detail).toBe('none running');
    expect(checkProcesses([{ pid: 7, command: '/x/bin/node --require /x/node_modules/tsx/dist/preflight.cjs packages/cli/src/main.ts dev:fake-collector SNEK' }], 1)
      .find((c) => c.name === 'fake collector')!.status).toBe('warn');
  });
  it('migrations: pending fails naming the files, orphans warn, in sync is ok', () => {
    expect(checkMigrations(['0001.sql', '0002.sql'], ['0001.sql'])).toMatchObject({ status: 'fail', detail: expect.stringMatching(/1 not applied: 0002.sql; run npm run migrate/) });
    expect(checkMigrations(['0001.sql'], ['0001.sql', '0002.sql'])).toMatchObject({ status: 'warn', detail: expect.stringMatching(/missing on disk: 0002.sql/) });
    expect(checkMigrations(['0001.sql', '0002.sql'], ['0002.sql', '0001.sql'])).toMatchObject({ status: 'ok', detail: '2 applied, none pending' });
  });
  it('fake rows and disk', () => {
    expect(checkFakeRows(0, 0).status).toBe('ok');
    expect(checkFakeRows(0, 3)).toMatchObject({ status: 'warn', detail: expect.stringMatching(/3 Fake candles/) });
    expect(checkDisk(4 * 1024 ** 3, '/')).toMatchObject({ status: 'warn', detail: '4.0 GB free on /; below 5 GB Postgres and the logs can run out mid-run' });
    expect(checkDisk(120 * 1024 ** 3, '/').status).toBe('ok');
  });
  it('digest lines: STALE and STOP fail/warn as they should, a LOST venue line is surfaced, and nothing is re-derived', () => {
    const ok = checkDigestLines(['collector: last tick x finished 4m ago | 20 pools', 'calls since 00:00 UTC: 100 (…) -> projected 14000/day of 50000 (28%) | quota: OK']);
    expect(ok.map((c) => c.status)).toEqual(['ok', 'ok']);
    const bad = checkDigestLines(['collector: STALE — last tick x', 'calls since 00:00 UTC: … | quota: STOP the collector (…)', 'venues LOST since the last discovery: MinswapV2 (…)']);
    expect(bad.map((c) => [c.name, c.status])).toEqual([['collector tick', 'warn'], ['quota pace', 'fail'], ['venues', 'warn']]);
    expect(checkDigestLines(['calls since 00:00 UTC: … | quota: WATCH'])[1]!.status).toBe('warn');
    expect(checkDigestLines([])[0]!.detail).toBe('(no digest line)');
  });
  it('verdict: any fail exits 1 and names it; warnings alone are OK with a count', () => {
    expect(verdict([{ name: 'a', status: 'ok', detail: '' }])).toEqual({ exitCode: 0, line: 'doctor: OK' });
    expect(verdict([{ name: 'a', status: 'warn', detail: '' }, { name: 'b', status: 'warn', detail: '' }])).toEqual({ exitCode: 0, line: 'doctor: OK with 2 warnings (a, b)' });
    expect(verdict([{ name: 'a', status: 'fail', detail: '' }, { name: 'b', status: 'warn', detail: '' }])).toEqual({ exitCode: 1, line: 'doctor: 1 FAIL (a), 1 warn' });
  });
});
