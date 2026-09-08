import { describe, expect, it } from 'vitest';
import { endpointFor, keysFromListXml, objectKey, readR2Setting, R2_VARS } from '../src/r2.js';

const full = {
  R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'ctb-backups',
  R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret',
} as NodeJS.ProcessEnv;

describe('readR2Setting', () => {
  it('is absent when nothing is set, so backups stay local with no ceremony', () => {
    expect(readR2Setting({} as NodeJS.ProcessEnv)).toEqual({ kind: 'absent' });
  });

  it('treats blank values as unset, the way dotenv leaves a bare KEY= line', () => {
    const blanks = Object.fromEntries(R2_VARS.map((v) => [v, '  '])) as NodeJS.ProcessEnv;
    expect(readR2Setting(blanks)).toEqual({ kind: 'absent' });
  });

  it('reads a complete configuration', () => {
    const s = readR2Setting(full);
    expect(s.kind).toBe('configured');
    if (s.kind === 'configured') expect(s.config.bucket).toBe('ctb-backups');
  });

  it('reports a PARTIAL configuration rather than falling back to local-only', () => {
    // The failure being designed against: three of four set, backups quietly stay on the one disk
    // they were meant to leave, and nobody finds out until a restore is needed. Silence must never
    // be able to mean "off-site backups are not happening".
    for (const missing of R2_VARS) {
      const env = { ...full };
      delete env[missing];
      const s = readR2Setting(env);
      expect(s.kind).toBe('partial');
      if (s.kind === 'partial') expect(s.missing).toEqual([missing]);
    }
  });

  it('names every missing variable, not just the first', () => {
    const s = readR2Setting({ R2_ACCOUNT_ID: 'acct' } as NodeJS.ProcessEnv);
    expect(s.kind).toBe('partial');
    if (s.kind === 'partial') expect(s.missing).toEqual(['R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
  });
});

describe('endpointFor', () => {
  it('puts the bucket in the path, not the subdomain, which is what R2 expects', () => {
    expect(endpointFor({ accountId: 'acct', bucket: 'ctb-backups' }))
      .toBe('https://acct.r2.cloudflarestorage.com/ctb-backups');
  });
});

describe('objectKey', () => {
  it('prefixes so a shared bucket stays legible', () => {
    expect(objectKey('ctb-2026-09-08T01-43-42-197Z.dump')).toBe('ctb/ctb-2026-09-08T01-43-42-197Z.dump');
  });
});

describe('keysFromListXml', () => {
  it('pulls keys out of an S3 ListObjectsV2 response', () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <Contents><Key>ctb/a.dump</Key><Size>1</Size></Contents>
      <Contents><Key>ctb/a.dump.manifest.json</Key><Size>2</Size></Contents>
    </ListBucketResult>`;
    expect(keysFromListXml(xml)).toEqual(['ctb/a.dump', 'ctb/a.dump.manifest.json']);
  });

  it('returns nothing for an empty bucket rather than throwing', () => {
    expect(keysFromListXml('<?xml version="1.0"?><ListBucketResult></ListBucketResult>')).toEqual([]);
  });
});
