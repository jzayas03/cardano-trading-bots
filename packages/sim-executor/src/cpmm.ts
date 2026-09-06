/** Constant-product swap output, bigint only. out = in·(10000−fee)·rOut / (rIn·10000 + in·(10000−fee)). */
export function cpmmAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error(`cpmm needs positive reserves, got in=${reserveIn} out=${reserveOut}`);
  if (amountIn < 0n) throw new Error(`cpmm amount must be non-negative, got ${amountIn}`);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) throw new Error(`cpmm fee out of range: ${feeBps} bps`);
  const f = 10_000n - BigInt(feeBps);
  const inWithFee = amountIn * f;
  return (inWithFee * reserveOut) / (reserveIn * 10_000n + inWithFee);
}

export function poolFeeTaken(amountIn: bigint, feeBps: number): bigint {
  return (amountIn * BigInt(feeBps)) / 10_000n;
}
