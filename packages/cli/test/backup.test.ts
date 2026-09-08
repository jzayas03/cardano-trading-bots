import { describe, expect, it } from 'vitest';
import {
  assertDroppable, compareCounts, dumpFileName, manifestFileName, newestDump, pruneOldDumps, verifyDbName,
} from '../src/backup.js';

describe('dump naming', () => {
  it('names sort chronologically as plain strings', () => {
    const a = dumpFileName(new Date('2026-09-08T01:00:00Z'));
    const b = dumpFileName(new Date('2026-09-08T02:00:00Z'));
    const c = dumpFileName(new Date('2026-09-09T00:00:00Z'));
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  it('produces a name with no characters that need quoting in a shell or a path', () => {
    expect(dumpFileName(new Date('2026-09-08T01:43:42.197Z'))).toBe('ctb-2026-09-08T01-43-42-197Z.dump');
  });

  it('puts the manifest beside the dump under one predictable rule', () => {
    expect(manifestFileName('ctb-x.dump')).toBe('ctb-x.dump.manifest.json');
  });
});

describe('newestDump', () => {
  it('ignores anything that is not a dump, including the manifests', () => {
    const files = ['ctb-2026-09-07T00-00-00-000Z.dump', 'ctb-2026-09-08T00-00-00-000Z.dump',
      'ctb-2026-09-08T00-00-00-000Z.dump.manifest.json', 'notes.txt'];
    expect(newestDump(files)).toBe('ctb-2026-09-08T00-00-00-000Z.dump');
  });

  it('returns undefined rather than throwing on an empty directory', () => {
    expect(newestDump([])).toBeUndefined();
    expect(newestDump(['only.manifest.json'])).toBeUndefined();
  });
});

describe('pruneOldDumps', () => {
  const files = ['a.dump', 'b.dump', 'c.dump', 'd.dump'].map((f, i) => `ctb-2026-09-0${i + 1}-${f}`);

  it('returns the dumps to DELETE, keeping the newest', () => {
    // The return value is the removal set on purpose: a retention bug that deletes the kept side is
    // unrecoverable, so the shape is the guard against writing the condition backwards.
    expect(pruneOldDumps(files, 2)).toEqual([files[0], files[1]]);
  });

  it('deletes nothing when there are fewer dumps than the retention', () => {
    expect(pruneOldDumps(files, 10)).toEqual([]);
    expect(pruneOldDumps([], 3)).toEqual([]);
  });

  it('never deletes everything: keep must be at least one', () => {
    expect(() => pruneOldDumps(files, 0)).toThrow(/at least 1/);
    expect(() => pruneOldDumps(files, -1)).toThrow(/at least 1/);
  });

  it('ignores manifests when deciding what to prune', () => {
    const withManifests = [...files, ...files.map((f) => `${f}.manifest.json`)];
    expect(pruneOldDumps(withManifests, 2)).toEqual([files[0], files[1]]);
  });
});

describe('compareCounts', () => {
  const manifest = [{ table: 'candles', rows: 10 }, { table: 'runs', rows: 3 }];

  it('is silent when the restore matches', () => {
    expect(compareCounts(manifest, [{ table: 'runs', rows: 3 }, { table: 'candles', rows: 10 }])).toEqual([]);
  });

  it('reports a table the restore is missing entirely', () => {
    // A truncated or partial restore looks exactly like this, which is the failure the whole
    // command exists to catch — it must never be treated as "nothing to compare".
    expect(compareCounts(manifest, [{ table: 'candles', rows: 10 }]))
      .toEqual([{ table: 'runs', expected: 3, actual: 'missing' }]);
  });

  it('reports a count that differs', () => {
    expect(compareCounts(manifest, [{ table: 'candles', rows: 9 }, { table: 'runs', rows: 3 }]))
      .toEqual([{ table: 'candles', expected: 10, actual: 9 }]);
  });

  it('reports a table the restore has and the manifest does not', () => {
    expect(compareCounts(manifest, [...manifest, { table: 'stowaway', rows: 1 }]))
      .toEqual([{ table: 'stowaway', expected: 0, actual: 1 }]);
  });

  it('does not treat a zero-row table as absent', () => {
    expect(compareCounts([{ table: 'empty', rows: 0 }], [{ table: 'empty', rows: 0 }])).toEqual([]);
    expect(compareCounts([{ table: 'empty', rows: 0 }], [])).toEqual([{ table: 'empty', expected: 0, actual: 'missing' }]);
  });
});

describe('assertDroppable', () => {
  it('accepts only a name this command generated', () => {
    expect(() => assertDroppable(verifyDbName(new Date('2026-09-08T01:43:49Z')))).not.toThrow();
  });

  it('refuses a real database, however plausible the name', () => {
    // This is the guard between a bug in verifyDbName and dropping someone's data.
    for (const name of ['ctb', 'postgres', 'ctb_prod', 'ctb_verify', 'ctb_verify_x', 'ctb_verify_123']) {
      expect(() => assertDroppable(name)).toThrow(/refusing to drop/);
    }
  });
});
