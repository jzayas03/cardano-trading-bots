import { describe, expect, it } from 'vitest';
import { isTransientHttpError, retryWithBackoff } from '../src/index.js';

const never = async () => {};
describe('retryWithBackoff', () => {
  it('returns on first success without sleeping', async () => {
    const slept: number[] = [];
    const v = await retryWithBackoff(async () => 7, { attempts: 3, baseMs: 100, maxMs: 1000, budgetMs: 10_000, isTransient: () => true, sleep: async (ms) => { slept.push(ms); } });
    expect(v).toBe(7);
    expect(slept).toEqual([]);
  });
  it('retries transient failures with growing jittered delays and succeeds', async () => {
    const slept: number[] = [];
    let n = 0;
    const v = await retryWithBackoff(async () => { if (++n < 3) throw new Error('429 too many'); return 'ok'; },
      { attempts: 5, baseMs: 100, maxMs: 10_000, budgetMs: 60_000, isTransient: isTransientHttpError, sleep: async (ms) => { slept.push(ms); }, random: () => 0.5 });
    expect(v).toBe('ok');
    expect(slept).toEqual([50, 100]); // full jitter with random=0.5: 100*0.5, 200*0.5
  });
  it('rethrows a non-transient error immediately', async () => {
    let n = 0;
    await expect(retryWithBackoff(async () => { n++; throw new Error('404 not found'); }, { attempts: 5, baseMs: 1, maxMs: 1, budgetMs: 1000, isTransient: isTransientHttpError, sleep: never }))
      .rejects.toThrow(/404/);
    expect(n).toBe(1);
  });
  it('gives up after `attempts` and says so', async () => {
    await expect(retryWithBackoff(async () => { throw new Error('503'); }, { attempts: 3, baseMs: 1, maxMs: 1, budgetMs: 1000, isTransient: () => true, sleep: never }))
      .rejects.toThrow(/503.*after 3 attempts/);
  });
  it('stops early when the budget would be exceeded', async () => {
    let n = 0;
    await expect(retryWithBackoff(async () => { n++; throw new Error('503'); }, { attempts: 10, baseMs: 5_000, maxMs: 5_000, budgetMs: 1_000, isTransient: () => true, sleep: never, random: () => 1 }))
      .rejects.toThrow(/budget/);
    expect(n).toBe(1);
  });
});
describe('isTransientHttpError', () => {
  it('classifies', () => {
    expect(isTransientHttpError(new Error('Request failed with status code 429'))).toBe(true);
    expect(isTransientHttpError(new Error('blockfrost /blocks/latest returned 502'))).toBe(true);
    expect(isTransientHttpError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientHttpError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientHttpError(new Error('Request failed with status code 403'))).toBe(false);
    expect(isTransientHttpError('Unable to determine DEX')).toBe(false);
  });
});
