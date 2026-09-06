import { cpmmAmountOut } from '@ctb/sim-executor';

export interface Reserves {
  reserveBase: bigint;
  reserveQuote: bigint;
}

/**
 * Mulberry32: a small, fast, deterministic 32-bit PRNG producing floats in [0, 1). Public-domain
 * reference algorithm (Tommy Ettinger) — used here, rather than `Math.random`, so `dev:fake-collector`'s
 * walk is fully reproducible from a `--seed` alone, with no external RNG dependency.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fee the synthetic walk swaps at — matches `poolFeeTaken`/`cpmmAmountOut`'s bps convention. */
const STEP_FEE_BPS = 30;
/** Parts-per-million cap on the swap size: 5000 ppm = 0.5% of the reserve being swapped in. */
const MAX_STEP_PPM = 5_000;
const PPM = 1_000_000n;

/**
 * One step of the synthetic constant-product walk. Two draws from `rng`: the first picks direction
 * (ADA swapped in vs. the base token swapped in), the second sizes that swap at 0-0.5% of the
 * reserve it swaps into (drawn in parts-per-million so the rest of the arithmetic is bigint-only).
 * `cpmmAmountOut` — the same function the real `SimExecutor` fills against — prices the swap at 30
 * bps, so the fee guarantees `reserveBase * reserveQuote` never decreases from one state to the next
 * (spec requirement); it can only hold exactly steady, when the drawn size rounds down to zero.
 */
export function fakeWalkStep(rng: () => number, current: Reserves): Reserves {
  const adaIn = rng() < 0.5;
  const ppm = BigInt(Math.floor(rng() * MAX_STEP_PPM));
  if (adaIn) {
    const amountIn = (current.reserveQuote * ppm) / PPM;
    const amountOut = cpmmAmountOut(amountIn, current.reserveQuote, current.reserveBase, STEP_FEE_BPS);
    return { reserveQuote: current.reserveQuote + amountIn, reserveBase: current.reserveBase - amountOut };
  }
  const amountIn = (current.reserveBase * ppm) / PPM;
  const amountOut = cpmmAmountOut(amountIn, current.reserveBase, current.reserveQuote, STEP_FEE_BPS);
  return { reserveBase: current.reserveBase + amountIn, reserveQuote: current.reserveQuote - amountOut };
}

/**
 * Deterministic sequence of `steps` states from `start`, seeded by `seed`. Pure, no I/O. `dev:fake-collector`
 * does not call this on every tick (it keeps one long-lived `rng` and calls `fakeWalkStep` directly,
 * so a restart can continue from the last DB snapshot instead of a `start` this function doesn't
 * know); the two produce identical numbers for the same seed and start (proven by the pinned fixture
 * in `fakeWalk.test.ts`), which is what makes this pure function a faithful spec of that stateful loop.
 */
export function fakeWalk(seed: number, steps: number, start: Reserves): Reserves[] {
  const rng = mulberry32(seed);
  const out: Reserves[] = [];
  let cur = start;
  for (let i = 0; i < steps; i++) {
    cur = fakeWalkStep(rng, cur);
    out.push(cur);
  }
  return out;
}

/**
 * Synthetic data can never be mistaken for real (global constraint). A tool that produces or
 * consumes fake data refuses to run unless BOTH hold: the operator explicitly opted in with
 * `CTB_ALLOW_FAKE_DATA=1`, and the database it is about to touch is on this machine. `new URL` is
 * used (not a string prefix check) so `postgres://user:pass@localhost.evil.example:5433/db` — where
 * `localhost` is a subdomain label, not the host — is correctly rejected.
 *
 * Finding I7: `who` exists because `paper --rehearsal` reuses this. The consumer needed the same
 * localhost bound as the producer — it gated only on `CTB_ALLOW_FAKE_DATA`, so the opt-in that is
 * safe on a laptop would have pointed a synthetic run at a remote database — and the refusal has to
 * name the command the operator actually typed.
 */
export function assertFakeAllowed(env: NodeJS.ProcessEnv, databaseUrl: string, who = 'dev:fake-collector'): void {
  if (env.CTB_ALLOW_FAKE_DATA !== '1') throw new Error(`${who} requires CTB_ALLOW_FAKE_DATA=1`);
  const host = new URL(databaseUrl).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`${who} requires a localhost database, got host ${host}`);
  }
}
