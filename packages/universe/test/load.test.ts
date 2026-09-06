import { describe, expect, it } from 'vitest';
import { loadUniverse, parseUniverse } from '../src/index.js';

const valid = {
  seededAt: '2026-09-05',
  seedSource: 'test',
  tokens: [
    { ticker: 'SNEK', policyId: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', assetNameHex: '534e454b', decimals: 0, category: 'Meme' },
    { ticker: 'MIN', policyId: '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6', assetNameHex: '4d494e', decimals: 6, category: 'Dex' },
  ],
};

describe('parseUniverse', () => {
  it('derives unit and ADA pairs', () => {
    const u = parseUniverse(valid);
    expect(u.tokens[0]?.unit).toBe('279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b');
    expect(u.pairs).toHaveLength(2);
    expect(u.pairs[1]?.quote).toBe('lovelace');
    expect(u.pairs[1]?.base.ticker).toBe('MIN');
  });

  it('fails closed on a bad policy id and names the entry', () => {
    const bad = structuredClone(valid);
    bad.tokens[1]!.policyId = 'not-hex';
    expect(() => parseUniverse(bad)).toThrow(/tokens\[1\]\.policyId.*MIN/);
  });

  it('rejects duplicate units', () => {
    const bad = structuredClone(valid);
    bad.tokens[1] = { ...bad.tokens[0]!, ticker: 'SNEK2' };
    expect(() => parseUniverse(bad)).toThrow(/duplicate unit/);
  });

  it('rejects duplicate tickers', () => {
    const bad = structuredClone(valid);
    bad.tokens[1] = { ...bad.tokens[1]!, ticker: 'SNEK' };
    expect(() => parseUniverse(bad)).toThrow(/duplicate ticker SNEK/);
  });

  it('rejects decimals outside 0..18', () => {
    const bad = structuredClone(valid);
    bad.tokens[0]!.decimals = 19;
    expect(() => parseUniverse(bad)).toThrow(/decimals/);
  });
});

describe('loadUniverse (committed file)', () => {
  it('loads exactly 20 tokens with unique units', async () => {
    const u = await loadUniverse();
    expect(u.tokens).toHaveLength(20);
    expect(new Set(u.tokens.map((t) => t.unit)).size).toBe(20);
    expect(u.pairs.every((p) => p.quote === 'lovelace')).toBe(true);
  });
});
