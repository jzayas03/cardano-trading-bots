import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://ctb:x@localhost:5433/ctb' };

/**
 * CTB_HEALTHCHECK_URL is the one credential this feature adds. Absent means alerting is off and
 * `watch` behaves exactly as before; present, it must be a shape the box can append `/fail`,
 * `/log` and `/<exit-status>` to without producing a URL the service would reject silently
 * (a wrong ping URL is a 200 with body "OK (not found)", not an error).
 */
describe('loadConfig: CTB_HEALTHCHECK_URL', () => {
  it('is undefined when absent', () => {
    expect(loadConfig(base, { blockfrost: false }).healthcheckUrl).toBeUndefined();
  });

  it('treats a blank value (the dotenv `KEY=` case) as absent', () => {
    expect(loadConfig({ ...base, CTB_HEALTHCHECK_URL: '' }, { blockfrost: false }).healthcheckUrl).toBeUndefined();
  });

  it('passes an https URL through unchanged', () => {
    expect(loadConfig({ ...base, CTB_HEALTHCHECK_URL: 'https://example.test/abc' }, { blockfrost: false }).healthcheckUrl)
      .toBe('https://example.test/abc');
  });

  it('rejects http:// and names the key', () => {
    expect(() => loadConfig({ ...base, CTB_HEALTHCHECK_URL: 'http://example.test/abc' }, { blockfrost: false }))
      .toThrow(/CTB_HEALTHCHECK_URL/);
  });

  it('rejects a query string', () => {
    expect(() => loadConfig({ ...base, CTB_HEALTHCHECK_URL: 'https://example.test/abc?x=1' }, { blockfrost: false }))
      .toThrow(/CTB_HEALTHCHECK_URL/);
  });

  it('rejects a trailing slash', () => {
    expect(() => loadConfig({ ...base, CTB_HEALTHCHECK_URL: 'https://example.test/abc/' }, { blockfrost: false }))
      .toThrow(/CTB_HEALTHCHECK_URL/);
  });
});
