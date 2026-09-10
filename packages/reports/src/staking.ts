import type { EquityPoint } from '@ctb/engine';

/**
 * Idle ADA is not idle. On Cardano, delegated ADA keeps earning while remaining spendable, so a run
 * that sits in cash is forgoing a yield — and every benchmark that ignores it **understates the
 * alternative**, which makes every strategy look better than it is.
 *
 * Raised in review 2026-09-09 and conceded: the honest opportunity cost of holding ADA is not zero.
 *
 * Two design choices worth stating, because both could have gone the other way:
 *
 * - **It credits every run, not only the baselines.** A directional strategy sitting in cash between
 *   trades earns this too. Crediting only the comparator would handicap the candidate, which is a
 *   different bias, not a fix. The consequence is that the correction favours whoever held more
 *   cash — which is exactly right, and is why it can change a ranking rather than only shift one.
 * - **It is a MEASUREMENT correction, applied to equity and never to cash.** Paying rewards into the
 *   run's balance would change what it could afford to buy and make it a different run. This says
 *   what the run WOULD have been worth, not what a rerun would do.
 */

/**
 * A placeholder so the correction can be applied at all — **assumed, never measured**, in the sense
 * `sim-executor`'s cost table uses the word. Real Cardano staking yield depends on protocol
 * parameters and on the chosen pool's performance, and is not something this project has measured.
 * Replace it with the founder's own figure; every report states which rate produced its numbers.
 */
export const ASSUMED_STAKING_APR_PCT = 3;

const MS_PER_YEAR = 365n * 24n * 60n * 60n * 1000n;
/** APR carried to six places in bigint, so a fractional rate does not become a float division. */
const APR_SCALE = 1_000_000n;

function msOf(p: EquityPoint, i: number): number {
  const t = p.tickTs.getTime();
  if (!Number.isFinite(t)) throw new Error(`equity point ${i} has an invalid tickTs; accruing over a NaN interval silently invents yield`);
  return t;
}

/**
 * Total staking credit over the series, in lovelace.
 *
 * Left-endpoint accrual: the cash balance at the START of an interval is the balance that was staked
 * through it. That makes the result independent of how finely the series is sampled, which a
 * right-endpoint or midpoint rule would not be.
 */
export function stakingCredit(equity: readonly EquityPoint[], aprPct: number): bigint {
  if (!Number.isFinite(aprPct) || aprPct < 0) throw new Error(`staking APR must be a non-negative number, got ${aprPct}`);
  if (equity.length < 2) return 0n;
  const apr = BigInt(Math.round(aprPct * Number(APR_SCALE)));
  if (apr === 0n) return 0n;

  let credit = 0n;
  for (let i = 1; i < equity.length; i++) {
    const from = equity[i - 1]!;
    const dtMs = BigInt(msOf(equity[i]!, i) - msOf(from, i - 1));
    if (dtMs <= 0n) continue;
    // Only the ADA earns: a position in the token is not delegated and yields nothing.
    credit += (from.cashLovelace * apr * dtMs) / (100n * APR_SCALE * MS_PER_YEAR);
  }
  return credit;
}

/**
 * The same series with the credit accrued INTO EQUITY as it earns — so a return computed from these
 * points is the staking-adjusted one. Cash and position are left exactly as they were: see the
 * module note on why paying it into cash would make this a different run.
 */
export function withStakingCredit(equity: readonly EquityPoint[], aprPct: number): EquityPoint[] {
  if (!Number.isFinite(aprPct) || aprPct < 0) throw new Error(`staking APR must be a non-negative number, got ${aprPct}`);
  if (equity.length === 0) return [];
  const apr = BigInt(Math.round(aprPct * Number(APR_SCALE)));

  const out: EquityPoint[] = [{ ...equity[0]! }];
  let credit = 0n;
  for (let i = 1; i < equity.length; i++) {
    const from = equity[i - 1]!;
    const dtMs = BigInt(msOf(equity[i]!, i) - msOf(from, i - 1));
    if (apr > 0n && dtMs > 0n) {
      credit += (from.cashLovelace * apr * dtMs) / (100n * APR_SCALE * MS_PER_YEAR);
    }
    const p = equity[i]!;
    out.push({
      ...p,
      equityLovelace: p.equityLovelace + credit,
      // The executable figure is what a real exit would fetch, and accrued rewards are part of it.
      equityExecutableLovelace: p.equityExecutableLovelace === null ? null : p.equityExecutableLovelace + credit,
    });
  }
  return out;
}
