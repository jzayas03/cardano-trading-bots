import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://ctb:x@localhost:5433/ctb' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base, { blockfrost: false });
    expect(c).toEqual({ databaseUrl: base.DATABASE_URL, blockfrostProjectId: null, intervalSec: 300, logLevel: 'info' });
  });

  it('requires BLOCKFROST_PROJECT_ID only when asked', () => {
    expect(() => loadConfig(base, { blockfrost: true })).toThrow(/BLOCKFROST_PROJECT_ID/);
    expect(loadConfig({ ...base, BLOCKFROST_PROJECT_ID: 'mainnetabc' }, { blockfrost: true }).blockfrostProjectId).toBe('mainnetabc');
  });

  it('rejects a non-integer or too-short interval', () => {
    expect(() => loadConfig({ ...base, COLLECT_INTERVAL_SECONDS: 'soon' }, { blockfrost: false })).toThrow(/COLLECT_INTERVAL_SECONDS/);
    expect(() => loadConfig({ ...base, COLLECT_INTERVAL_SECONDS: '10' }, { blockfrost: false })).toThrow(/COLLECT_INTERVAL_SECONDS/);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({}, { blockfrost: false })).toThrow(/DATABASE_URL/);
  });

  it('pins an empty BLOCKFROST_PROJECT_ID as absent, not a validation failure', () => {
    // .env.example ships a bare `BLOCKFROST_PROJECT_ID=` line, which dotenv loads as ''.
    // Commands that don't need Blockfrost must still succeed; commands that do must still
    // fail closed and name the variable, exactly as when it's unset.
    expect(loadConfig({ ...base, BLOCKFROST_PROJECT_ID: '' }, { blockfrost: false })).toEqual({
      databaseUrl: base.DATABASE_URL,
      blockfrostProjectId: null,
      intervalSec: 300,
      logLevel: 'info',
    });
    expect(() => loadConfig({ ...base, BLOCKFROST_PROJECT_ID: '' }, { blockfrost: true })).toThrow(
      /BLOCKFROST_PROJECT_ID/,
    );
  });
});
