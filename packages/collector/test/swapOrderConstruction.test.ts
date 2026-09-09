import { describe, expect, it } from 'vitest';
import { AddressType, Asset, DatumParameterKey, LiquidityPool, MinswapV2, MockWalletProvider } from '@indigo-labs/dexter';

/**
 * M6.1, the half of it that can be met without a key: **does Dexter's swap-order construction
 * actually run?** The original spike reached a real quote and then died building the order:
 *
 *   JsValue("Deserialization failed in Ed25519KeyHash because:
 *            Invalid cbor: expected tuple 'hash length' of length 28 but got length Len(2).")
 *
 * The cause, now read rather than guessed: `MockWalletProvider` ships
 * `_paymentCredential = 'ed56'` and `_stakingCredential = 'bac6'` — TWO bytes each — and
 * `buildSwapOrder` passes the staking one straight into `lucidUtils.credentialToAddress()`, which
 * needs 28. The mock was never a wallet; it was a stub with placeholder strings.
 *
 * Overriding those two accessors with structurally valid 28-byte hashes is enough, and the whole
 * path below is LOCAL: no Blockfrost, no preprod, no funds, no key material. The reserves are our
 * own collected NIGHT/ADA MinswapV2 candle from 2026-09-08 19:30Z, so the order is a realistic one.
 *
 * **What this does NOT prove.** That the datum is CORRECT. A datum that serialises can still be
 * wrong in a way that loses funds rather than erroring, and on Cardano that is the failure mode
 * that matters. M6.1's preprod gate stands; this retires only the "does it run at all" half.
 */

/** 28 bytes as 56 hex characters — the shape `credentialToAddress` demands and the mock lacks. */
const PAYMENT_KEY_HASH = 'a'.repeat(56);
const STAKING_KEY_HASH = 'b'.repeat(56);

class StructurallyValidMockWallet extends MockWalletProvider {
  override publicKeyHash(): string { return PAYMENT_KEY_HASH; }
  override stakingKeyHash(): string { return STAKING_KEY_HASH; }
}

const NIGHT = new Asset('0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa', '4e49474854', 6);
/** MinswapV2 NIGHT/ADA, from our own candle at 2026-09-08 19:30Z: 22.13M NIGHT against 2.26M ADA. */
const IDENTIFIER = 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ce74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1b23c5713169';

function nightAdaPool(): LiquidityPool {
  const pool = new LiquidityPool('MinswapV2', NIGHT, 'lovelace' as never, 22_129_076_180_093n, 2_262_666_537_541n, 'addr_pool');
  pool.identifier = IDENTIFIER;
  pool.poolFeePercent = 0.3;
  // Synthetic, and only the datum's byte fields need it. Whether these are the REAL LP token for
  // this pool is a correctness question, which is preprod's job and not this test's claim.
  pool.lpToken = new Asset(IDENTIFIER.slice(0, 56), IDENTIFIER.slice(56), 0);
  return pool;
}

/** 100 ADA in, mirroring what `SwapRequest` assembles, with a 1% slippage allowance. */
function swapParameters(wallet: MockWalletProvider): Record<string, unknown> {
  return {
    [DatumParameterKey.SenderPubKeyHash]: wallet.publicKeyHash(),
    [DatumParameterKey.SenderStakingKeyHash]: wallet.stakingKeyHash(),
    [DatumParameterKey.ReceiverPubKeyHash]: wallet.publicKeyHash(),
    [DatumParameterKey.ReceiverStakingKeyHash]: wallet.stakingKeyHash(),
    [DatumParameterKey.PoolIdentifier]: IDENTIFIER,
    [DatumParameterKey.SwapInAmount]: 100_000_000n,
    [DatumParameterKey.MinReceive]: 960_000_000n,
    [DatumParameterKey.SwapInTokenPolicyId]: '',
    [DatumParameterKey.SwapInTokenAssetName]: '',
    [DatumParameterKey.SwapOutTokenPolicyId]: NIGHT.policyId,
    [DatumParameterKey.SwapOutTokenAssetName]: NIGHT.nameHex,
  };
}

describe('M6.1 — a MinswapV2 swap order constructs, with no key and no network', () => {
  it('builds one contract-bound payment carrying a datum', async () => {
    const wallet = new StructurallyValidMockWallet();
    const payments = await new MinswapV2().buildSwapOrder(nightAdaPool(), swapParameters(wallet) as never);

    expect(payments).toHaveLength(1);
    const [payment] = payments;
    // The order goes to the BATCHER CONTRACT, never to a counterparty: that is the whole shape of a
    // Cardano DEX swap, and getting it wrong loses funds rather than erroring.
    expect(payment!.addressType).toBe(AddressType.Contract);
    expect(payment!.address).toMatch(/^addr/);
    expect(typeof payment!.datum).toBe('string');
    expect(payment!.datum!.length).toBeGreaterThan(0);
    expect(payment!.isInlineDatum).toBe(false);
  });

  it('locks the swap amount PLUS a 4 ADA overhead, of which only 2 is a cost', async () => {
    // The dynamic half of `dexterWritesTheBatcherFee.guard.test.ts` (#104), which reads the same
    // numbers statically out of the adapter source. Asserted as the DIFFERENCE rather than as a
    // total, because the total scales with the order and the overhead does not — and the overhead
    // is the number that sets a minimum order size.
    const swapIn = 100_000_000n;
    const payments = await new MinswapV2().buildSwapOrder(nightAdaPool(), swapParameters(new StructurallyValidMockWallet()) as never);
    const lovelace = payments[0]!.assetBalances.find((b) => b.asset === 'lovelace');
    expect(lovelace?.quantity).toBe(swapIn + 4_000_000n);
    // 2 ADA batcher fee (never returned) + 2 ADA deposit (returned on processing or cancellation).
    // Capital leaving the wallet is double the cost the floor counts.
    expect(lovelace!.quantity - swapIn).toBe(4_000_000n);
  });

  it('fails on the STOCK mock with the spike\'s exact error, which is what makes the override the fix', async () => {
    // The negative control, pinned to the SPECIFIC failure rather than to "it threw" — otherwise any
    // unrelated breakage would keep this green and the override above would look proven when it was
    // not. Matched by string because the rejection is a WASM `JsValue`, not an Error instance, so
    // `rejects.toThrow` has nothing to unwrap.
    const err = await new MinswapV2()
      .buildSwapOrder(nightAdaPool(), swapParameters(new MockWalletProvider()) as never)
      .then(() => null, (e: unknown) => String(e));
    expect(err).toMatch(/Ed25519KeyHash/);
    expect(err).toMatch(/expected tuple 'hash length' of length 28 but got length Len\(2\)/);
  });
});
