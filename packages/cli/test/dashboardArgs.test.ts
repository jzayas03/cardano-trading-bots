import { describe, expect, it } from 'vitest';
import { parseDashboardArgs } from '../src/commands/dashboard.js';

describe('parseDashboardArgs', () => {
  it('defaults to port 3210 when no flags are given', () => {
    expect(parseDashboardArgs([])).toEqual({ port: 3210 });
  });

  it('accepts a valid --port', () => {
    expect(parseDashboardArgs(['--port', '4000'])).toEqual({ port: 4000 });
  });

  it('rejects a bare --port with no value', () => {
    expect(() => parseDashboardArgs(['--port'])).toThrow(/--port must be an integer 1024-65535/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseDashboardArgs(['--port', 'soon'])).toThrow(/--port must be an integer 1024-65535/);
  });

  it('rejects an out-of-range port below 1024', () => {
    expect(() => parseDashboardArgs(['--port', '1023'])).toThrow(/--port must be an integer 1024-65535/);
  });

  it('rejects an out-of-range port above 65535', () => {
    expect(() => parseDashboardArgs(['--port', '65536'])).toThrow(/--port must be an integer 1024-65535/);
  });

  it('accepts the boundary ports 1024 and 65535', () => {
    expect(parseDashboardArgs(['--port', '1024'])).toEqual({ port: 1024 });
    expect(parseDashboardArgs(['--port', '65535'])).toEqual({ port: 65535 });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseDashboardArgs(['--bogus'])).toThrow(/unknown argument --bogus/);
  });
});
