import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VENUE_COSTS } from '../src/index.js';

/**
 * What Dexter WRITES INTO THE ORDER DATUM is what we would pay — not what a venue's documentation,
 * or a helpful reviewer, says the venue charges. Reviewed 2026-09-09: a reviewer reported (correctly,
 * as policy) that Minswap removed batcher fees in May 2025, and advised lowering our cost table from
 * 2.20 to 0.20 ADA and "stop penalizing your strategies with ghost fees".
 *
 * Acting on that would have modelled 176 bps while still paying 216, overstating every strategy's
 * edge by 40 bps in exactly the direction that pushes a losing strategy through the promotion gate.
 * Dexter 5.4.10 hardcodes `batcherFee: 2000000n` into the MinswapV2 datum; offering it in the datum
 * is paying it.
 *
 * The proof that Dexter's constant is not a reading of current policy is Minswap V1: Dexter carries
 * the IDENTICAL 2 ADA for a venue our own table has at ZERO from a documented source. So the library
 * does not distinguish the two, and its V2 figure is evidence about the library, not about Minswap.
 *
 * This guard pins that whole situation so it cannot drift silently through a dependency bump. When
 * it fails, that is NEWS rather than breakage: read the new values, and change the SUBMISSION path
 * (override the datum parameter) before changing the model, never the other way round.
 *
 * Static read of the vendored file, deliberately: importing Dexter drags lucid + WASM into vitest's
 * transform graph, which is why `@ctb/collector` has a `/pure` entry point at all.
 */
const DEX_DIR = resolve(import.meta.dirname, '../../../node_modules/@indigo-labs/dexter/build/dex');

interface DexterFee { id: string; value: bigint; isReturned: boolean }

function swapOrderFees(adapter: string): DexterFee[] {
  const file = resolve(DEX_DIR, `${adapter}.js`);
  if (!existsSync(file)) {
    throw new Error(`Dexter adapter ${adapter}.js not found at ${file}. If a version bump moved it, re-read the new file and update this guard AND the cost table together.`);
  }
  const block = /swapOrderFees\(\) \{([\s\S]*?)\n    \}/.exec(readFileSync(file, 'utf8'));
  if (block === null) throw new Error(`no swapOrderFees() found in ${adapter}.js — Dexter's shape changed; re-read it.`);
  return [...block[1]!.matchAll(/id: '(\w+)',[\s\S]*?value: (\d+)n,\s*isReturned: (true|false),/g)]
    .map((m) => ({ id: m[1]!, value: BigInt(m[2]!), isReturned: m[3] === 'true' }));
}

const feeOf = (adapter: string, id: string): DexterFee => {
  const f = swapOrderFees(adapter).find((x) => x.id === id);
  if (f === undefined) throw new Error(`no ${id} in ${adapter}'s swapOrderFees()`);
  return f;
};

describe('the batcher fee we would actually pay is the one Dexter writes', () => {
  it('MinswapV2: Dexter hardcodes 2 ADA, and our model matches the submission path', () => {
    const batcher = feeOf('minswap-v2', 'batcherFee');
    expect(batcher.value).toBe(2_000_000n);
    expect(batcher.isReturned).toBe(false);
    // The model must equal what we would submit. Lower this ONLY after the datum parameter is
    // overridden at submission -- the model follows the submission path, never leads it.
    expect(VENUE_COSTS.MinswapV2.batcherFeeLovelace).toBe(batcher.value);
  });

  it('Minswap V1 is the proof Dexter is stale: it writes 2 ADA where documentation says zero', () => {
    const batcher = feeOf('minswap', 'batcherFee');
    expect(batcher.value).toBe(2_000_000n);
    // Deliberately asserting a DISAGREEMENT. Our V1 entry is 0 from a documented source; Dexter still
    // writes 2 ADA. If this ever stops disagreeing, Dexter has been updated -- which is precisely the
    // moment to re-examine V2 and the override below, so failing here is the alarm working.
    expect(VENUE_COSTS.Minswap.batcherFeeLovelace).toBe(0n);
    expect(VENUE_COSTS.Minswap.batcherFeeLovelace).not.toBe(batcher.value);
  });

  it('SundaeSwapV3: the model follows Dexter here too, and the docs do not', () => {
    // The adapter reads `protocolFeeDefault` rather than a literal, so this reads the assignment.
    const src = readFileSync(resolve(DEX_DIR, 'sundaeswap-v3.js'), 'utf8');
    const m = /protocolFeeDefault\s*=\s*(\d+)n/.exec(src);
    expect(m, 'protocolFeeDefault assignment not found — Dexter changed shape; re-read it').not.toBeNull();
    const written = BigInt(m![1]!);
    expect(written).toBe(1_280_000n);
    expect(VENUE_COSTS.SundaeSwapV3.batcherFeeLovelace).toBe(written);
    // SundaeV3.pdf documents 0.5-1.0 ADA. The library writes 1.28, and the M6.1 spike measured 1.28
    // on a live quote. Documentation is not the submission path.
    expect(written).toBeGreaterThan(1_000_000n);
  });

  it('a deposit leaves the wallet with every order and comes back, so it is capital and not cost', () => {
    // No cost table shows this, and the floor is right not to: it returns. But 4 ADA leaves per
    // order against 2 ADA of cost, which sets the real minimum order size and feeds the open
    // working-capital question.
    const deposit = feeOf('minswap-v2', 'deposit');
    expect(deposit.value).toBe(2_000_000n);
    expect(deposit.isReturned).toBe(true);
    const batcher = feeOf('minswap-v2', 'batcherFee');
    expect(deposit.value + batcher.value).toBe(4_000_000n);
    // The floor counts only what does not come back.
    expect(VENUE_COSTS.MinswapV2.batcherFeeLovelace).toBe(batcher.value);
  });
});
