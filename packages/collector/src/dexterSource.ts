import { Asset, BlockfrostProvider, Dexter, type LiquidityPool } from '@indigo-labs/dexter';
import type { Pair } from '@ctb/universe';
import type { RunError } from './repo.js';
import type { DiscoveryCallsSource, PoolSource, SourceResult } from './source.js';
import type { Logger, PoolLike } from './types.js';
import { discoveryOf, VENUE_NAMES, type DexName } from './venues.js';
import { collectPoolShapes, collectRefreshedShape, type LiquidityPoolShape } from './poolShape.js';
import type { FetcherAsset, PoolFetcher } from './poolFetcher.js';
import { isTransientHttpError, retryWithBackoff } from './retry.js';

export type { LiquidityPoolShape } from './poolShape.js';
export { toPoolLike } from './poolShape.js';
export type { FetcherAsset, PoolFetcher } from './poolFetcher.js';

/**
 * Venues whose Dexter-native discovery is unusable and are instead discovered per address/token via
 * `DefaultPoolFetcher`'s bounded path (see the file header comment on `discoverBounded` below).
 * Derived from `VENUES[*].discovery` in `venues.ts` so the fact lives in one place — flipping a
 * venue's `discovery` to `'per-token-address'` there is enough to opt it into this path, though the
 * default `splashClient` wiring below is still Splash-specific until another venue needs it too.
 *
 * Currently empty: Splash (the one venue that ever used this path) moved to `discovery:
 * 'unsupported'` in `venues.ts`, because Dexter 5.4.10's own `liquidityPoolFromUtxo` never returns a
 * pool no matter how it's called, so the bounded path can't find anything either — see that file's
 * header comment for the verified detail. `DefaultPoolFetcherOptions.discoveryOverride` below is the
 * seam for forcing a venue onto this path regardless of `venues.ts` (tests use it to exercise
 * `discoverBounded` directly); it doubles as the one-line change to re-enable Splash here once Dexter
 * is fixed or upgraded.
 */
const BOUNDED_DISCOVERY: Partial<Record<DexName, 'per-token-address'>> = Object.fromEntries(
  VENUE_NAMES
    .filter((name) => discoveryOf(name) === 'per-token-address')
    .map((name) => [name, 'per-token-address' as const]),
);

/**
 * Seam for the bounded per-address/token Splash discovery (`DefaultPoolFetcher.discoverBounded`).
 * `addresses()`/`utxos()`/`poolFromUtxo()` mirror the three Dexter/Blockfrost calls the default
 * (production) implementation makes; a unit test injects a fake here via
 * `DefaultPoolFetcherOptions.splashClient` instead of touching Dexter or the network.
 */
export interface SplashDiscoveryClient {
  /** The venue's fixed pool addresses (Dexter's own `BaseDex.liquidityPoolAddresses`). */
  addresses(): Promise<string[]>;
  /** UTxOs at one address holding the given asset (Blockfrost's asset-filtered UTxO endpoint). */
  utxos(address: string, asset: FetcherAsset): Promise<unknown[]>;
  /** Parses one UTxO into pool state, or `undefined` if it isn't a pool UTxO for this asset. */
  poolFromUtxo(utxo: unknown): Promise<LiquidityPoolShape | undefined>;
}

/** `pool`'s two sides as Dexter's own `Asset.identifier()` format: `'lovelace'` or `policyId + nameHex`. */
function poolSideIdentifiers(pool: LiquidityPoolShape): [string, string] {
  const idOf = (side: LiquidityPoolShape['assetA']) => (side === 'lovelace' ? 'lovelace' : `${side.policyId}${side.nameHex}`);
  return [idOf(pool.assetA), idOf(pool.assetB)];
}

/** True if `pool` is an ADA pair for one of the requested `tokenPairs`, compared the way Dexter's own
 *  `tokensMatch` does: by identifier (`policyId + nameHex`), not object identity. */
function poolMatchesRequestedPair(pool: LiquidityPoolShape, tokenPairs: ReadonlyArray<['lovelace', Asset]>): boolean {
  const [idA, idB] = poolSideIdentifiers(pool);
  return tokenPairs.some(([, asset]) => {
    const tokenId = asset.identifier();
    return (idA === 'lovelace' && idB === tokenId) || (idB === 'lovelace' && idA === tokenId);
  });
}

/** Counts provider method calls so each tick can report its Blockfrost cost. Paginated calls count once per method call. */
class CountingBlockfrostProvider extends BlockfrostProvider {
  calls = 0;
  override utxos(...args: Parameters<BlockfrostProvider['utxos']>) { this.calls++; return super.utxos(...args); }
  override transactionUtxos(...args: Parameters<BlockfrostProvider['transactionUtxos']>) { this.calls++; return super.transactionUtxos(...args); }
  override assetTransactions(...args: Parameters<BlockfrostProvider['assetTransactions']>) { this.calls++; return super.assetTransactions(...args); }
  override assetAddresses(...args: Parameters<BlockfrostProvider['assetAddresses']>) { this.calls++; return super.assetAddresses(...args); }
  override datumValue(...args: Parameters<BlockfrostProvider['datumValue']>) { this.calls++; return super.datumValue(...args); }
}

/**
 * Structural view of the piece of Dexter that `DefaultPoolFetcher.poolState` needs — just the one
 * on-chain call it wraps in retry. Kept separate from `PoolFetcher` (which is the seam for the
 * whole `DexterPoolSource`) so a unit test can prove the retry wrapping around this single call
 * with a plain fake, without importing Dexter, touching the network, or faking `discoverVenue` too.
 */
export interface PoolStateClient {
  getLiquidityPoolState(pool: LiquidityPoolShape): Promise<LiquidityPoolShape | undefined>;
}

export interface DefaultPoolFetcherOptions {
  url: string;
  projectId: string;
  log: Logger;
  retryBudgetMs: number;
  /** Injectable seam for tests (finding: DefaultPoolFetcher.poolState's retry wrapping was untested).
   *  Omit to use the real Dexter-backed client, wired up exactly as before. */
  poolStateClient?: PoolStateClient;
  /** Injectable seam for the retry backoff's sleep, so a unit test proving retry behavior does not wait on a real timer. Omit for a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable seam for tests covering the bounded Splash discovery path. Omit to use the real
   *  Dexter/Blockfrost-backed client (`this.dexter.dexByName('Splash')` + `this.provider.utxos`). */
  splashClient?: SplashDiscoveryClient;
  /**
   * Forces the given venues onto the bounded per-address/token discovery path (`discoverBounded`)
   * regardless of their `VENUES[*].discovery` value in `venues.ts`. Merged on top of the derived
   * `BOUNDED_DISCOVERY` map, which is currently empty (Splash is `'unsupported'` there — Dexter never
   * returns its pools, see `venues.ts`'s header comment). Tests use this to exercise
   * `discoverBounded` directly, with a fake `splashClient`, without waiting on `venues.ts` to
   * re-enable a venue. Omit to use only the derived map.
   */
  discoveryOverride?: Partial<Record<DexName, 'per-token-address'>>;
}

/** The real `PoolFetcher`: wraps Dexter exactly as `DexterPoolSource` always has. Constructing it is
 *  synchronous and makes no network call (Dexter/BlockfrostProvider only build an axios client in
 *  their constructors), so it is safe to construct even in a unit test that never calls it. */
class DefaultPoolFetcher implements PoolFetcher {
  private readonly dexter: Dexter;
  private readonly provider: CountingBlockfrostProvider;
  private readonly log: Logger;
  private readonly retryBudgetMs: number;
  private readonly poolStateClient: PoolStateClient;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly splashClient: SplashDiscoveryClient;
  /** `BOUNDED_DISCOVERY` merged with `opts.discoveryOverride` — see that option's doc comment. */
  private readonly discoveryMap: Partial<Record<DexName, 'per-token-address'>>;
  /** Address/token queries that failed on the most recent `discoverBounded` call, per venue. Read by
   *  `DexterPoolSource.discover` right after `discoverVenue` returns, via `partialFailures(venue)`. */
  private readonly partialFailuresByVenue = new Map<DexName, number>();

  constructor(opts: DefaultPoolFetcherOptions) {
    this.provider = new CountingBlockfrostProvider({ url: opts.url, projectId: opts.projectId }, { timeout: 20_000, retries: 2 });
    // shouldFallbackToApi false: an on-chain failure must surface as a failure, not as a quietly different data source.
    this.dexter = new Dexter({ shouldFetchMetadata: false, shouldFallbackToApi: false }, { timeout: 20_000, retries: 2 });
    this.dexter.withDataProvider(this.provider);
    this.log = opts.log;
    this.retryBudgetMs = opts.retryBudgetMs;
    this.sleep = opts.sleep;
    // Production wiring, unchanged in behavior: adapt the real Dexter FetchRequest to PoolStateClient,
    // including the same `as unknown as` casts DefaultPoolFetcher always used at this boundary.
    this.poolStateClient = opts.poolStateClient ?? {
      getLiquidityPoolState: async (pool) => {
        const state = await this.dexter.newFetchRequest().getLiquidityPoolState(pool as unknown as LiquidityPool);
        return state as unknown as LiquidityPoolShape | undefined;
      },
    };
    // Production wiring for the bounded Splash path: the same Dexter DEX object and provider used
    // above, just called directly instead of through Dexter's own unbounded FetchRequest.
    this.splashClient = opts.splashClient ?? {
      addresses: async () => {
        const dex = this.dexter.dexByName('Splash') as unknown as
          { liquidityPoolAddresses(provider: unknown): Promise<string[]> } | undefined;
        if (!dex) throw new Error("Dexter has no 'Splash' venue registered");
        return dex.liquidityPoolAddresses(this.provider);
      },
      utxos: async (address, asset) => this.provider.utxos(address, new Asset(asset.policyId, asset.nameHex, asset.decimals)),
      poolFromUtxo: async (utxo) => {
        const dex = this.dexter.dexByName('Splash') as unknown as
          { liquidityPoolFromUtxo(provider: unknown, utxo: unknown): Promise<LiquidityPoolShape | undefined> } | undefined;
        if (!dex) throw new Error("Dexter has no 'Splash' venue registered");
        const pool = await dex.liquidityPoolFromUtxo(this.provider, utxo);
        return pool as unknown as LiquidityPoolShape | undefined;
      },
    };
    this.discoveryMap = { ...BOUNDED_DISCOVERY, ...opts.discoveryOverride };
  }

  providerCalls(): number { return this.provider.calls; }
  resetProviderCalls(): void { this.provider.calls = 0; }
  partialFailures(venue: DexName): number { return this.partialFailuresByVenue.get(venue) ?? 0; }

  async discoverVenue(venue: DexName, tokenPairs: Array<['lovelace', Asset]>): Promise<LiquidityPoolShape[]> {
    if (this.discoveryMap[venue] === 'per-token-address') {
      return this.discoverBounded(venue, tokenPairs);
    }
    const pools = await this.dexter.newFetchRequest().onDexs(venue).forTokenPairs(tokenPairs).getLiquidityPools();
    return pools as unknown as LiquidityPoolShape[];
  }

  /**
   * Bounded alternative to Dexter's `FetchRequest` for venues like Splash, whose own on-chain
   * discovery (`liquidityPools()`) scans every UTxO at a fixed set of pool addresses unfiltered —
   * for Splash that's thousands of tiny pools per tick (measured: a single tick ran 50+ minutes
   * without finishing). Blockfrost's `/addresses/{address}/utxos/{asset}` filters by asset, so this
   * queries only the requested token(s) at each of the venue's addresses instead: about
   * `addresses.length * tokenPairs.length` calls instead of one call per UTxO at those addresses.
   *
   * One address/token query failing must not drop pools a different query already found — each is
   * its own try/catch, counted into `partialFailuresByVenue` and logged at warn, and surfaced by
   * `DexterPoolSource.discover` as one `discover:${venue}` RunError once discovery otherwise succeeds.
   * A failure listing the venue's addresses at all (`this.splashClient.addresses()`) is not caught
   * here and instead propagates to `DexterPoolSource.discover`'s own catch, which already reports a
   * total venue failure — the same as any other on-chain discovery error.
   */
  private async discoverBounded(venue: DexName, tokenPairs: Array<['lovelace', Asset]>): Promise<LiquidityPoolShape[]> {
    const addresses = await this.splashClient.addresses();
    const found = new Map<string, LiquidityPoolShape>();
    let failures = 0;
    for (const address of addresses) {
      for (const [, asset] of tokenPairs) {
        try {
          const utxos = await this.splashClient.utxos(address, { policyId: asset.policyId, nameHex: asset.nameHex, decimals: asset.decimals });
          for (const utxo of utxos) {
            const pool = await this.splashClient.poolFromUtxo(utxo);
            if (pool && poolMatchesRequestedPair(pool, tokenPairs)) {
              found.set(pool.identifier, pool);
            }
          }
        } catch (err) {
          failures++;
          const message = (err as Error).message ?? String(err);
          this.log.warn({ venue, address, asset: asset.identifier(), err: message }, 'bounded discovery query failed');
        }
      }
    }
    this.partialFailuresByVenue.set(venue, failures);
    return [...found.values()];
  }

  // Dexter's `retries` option is inert for BlockfrostProvider (its constructor reads only
  // timeout/proxyUrl) and Dexter's global axiosRetry does not apply to the provider's own axios
  // instance, so a transient Blockfrost failure here would otherwise surface as a single-shot
  // refresh failure. Wrapped, not `discoverVenue`: Dexter swallows discovery errors internally
  // (see the venue-failure comment in `discover` below), so a retry there would never fire.
  async poolState(pool: LiquidityPoolShape): Promise<LiquidityPoolShape | undefined> {
    return retryWithBackoff(
      () => this.poolStateClient.getLiquidityPoolState(pool),
      {
        attempts: 4, baseMs: 500, maxMs: 8_000, budgetMs: this.retryBudgetMs,
        isTransient: isTransientHttpError,
        sleep: this.sleep,
        onRetry: (info) => this.log.warn(info, 'blockfrost retry'),
      },
    );
  }
}

export { DefaultPoolFetcher };

export interface DexterPoolSourceOptions {
  blockfrostProjectId: string;
  blockfrostUrl?: string;
  log: Logger;
  venues?: DexName[];
  fetch?: typeof fetch;
  /** Injectable seam for tests. Omit to use the real Dexter-backed fetcher. */
  fetcher?: PoolFetcher;
  /** Wall-clock ceiling for the retry-with-backoff wrapping `tip()` and pool-state refresh calls. Default 60_000. */
  retryBudgetMs?: number;
  /** Injectable seam for the retry backoff's sleep, so a unit test proving retry behavior does not wait on a real timer. Omit for a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Which pools `refresh()` spends Blockfrost calls on after a successful `discover()`.
   * - `'all'` (default): refresh every discovered pool, unchanged from this class's original
   *   behavior — kept as the default so every existing caller/test keeps its current meaning.
   * - `'deepest'`: prune the known set to one pool per base token — the pool with the largest ADA
   *   reserve, ties broken by smallest identifier — before `refresh()` ever runs. Candles already
   *   only use the deepest pool per token per tick (`buildCandles` in `@ctb/candles`), so refreshing
   *   every shallow duplicate spends Blockfrost quota on data nothing reads. Run 50 (2026-09-06,
   *   real key, mainnet): 102 discovered pools x ~10 calls each to refresh x 288 ticks/day (5-minute
   *   interval) is ~290k calls/day against a 50k/day free quota; pruning to ~20 deepest pools brings
   *   that down to the arithmetic in `.env.example`. Discovery itself is unaffected by this option —
   *   `discover()` still returns every pool it found so `pool_snapshots` keeps the full picture on a
   *   discovery tick; only the internal known set used by subsequent `refresh()` calls is pruned. The
   *   CLI's `collect` command passes `cfg.refreshPolicy` (default `'deepest'` there — see
   *   `packages/cli/src/config.ts`).
   */
  refreshPolicy?: 'deepest' | 'all';
}

/** `shape`'s non-ADA-side token identifier (`policyId + nameHex`), used to group pools by base token
 *  for `'deepest'` pruning. Every pool `DexterPoolSource` ever discovers is an ADA pair (`discover`
 *  only ever requests `['lovelace', asset]` token pairs), but a pool with no ADA side — or with ADA
 *  on both sides — can't be compared against others by "largest ADA reserve", so it falls back to
 *  `poolId` (unique per pool) and stands in a group of its own rather than being silently dropped or
 *  merged with an unrelated group. */
function groupKeyOf(poolId: string, shape: LiquidityPoolShape): string {
  const aIsAda = shape.assetA === 'lovelace';
  const bIsAda = shape.assetB === 'lovelace';
  if (aIsAda === bIsAda) return poolId;
  const nonAda = aIsAda ? shape.assetB : shape.assetA;
  return typeof nonAda === 'string' ? poolId : `${nonAda.policyId}${nonAda.nameHex}`;
}

/** The lovelace-side reserve of `shape` (the "ADA depth" `'deepest'` pruning ranks pools by), or
 *  `undefined` for a pool with no ADA side (see `groupKeyOf`). */
function adaReserveOf(shape: LiquidityPoolShape): bigint | undefined {
  if (shape.assetA === 'lovelace') return shape.reserveA;
  if (shape.assetB === 'lovelace') return shape.reserveB;
  return undefined;
}

const TIP_TIMEOUT_MS = 10_000;

export class DexterPoolSource implements PoolSource, DiscoveryCallsSource {
  private readonly fetcher: PoolFetcher;
  private readonly defaultFetcher: DefaultPoolFetcher | null;
  private readonly known = new Map<string, LiquidityPoolShape>();
  private readonly venues: DexName[];
  private readonly url: string;
  private readonly projectId: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBudgetMs: number;
  private readonly sleep?: (ms: number) => Promise<void>;
  /** See `DexterPoolSourceOptions.refreshPolicy`. Default `'all'`. */
  private readonly refreshPolicy: 'deepest' | 'all';
  /** Blockfrost provider calls spent per venue on the most recent `discover()`. Read by `lastDiscoveryCalls`. */
  private callsByVenue: Record<string, number> = {};

  constructor(opts: DexterPoolSourceOptions) {
    this.url = opts.blockfrostUrl ?? 'https://cardano-mainnet.blockfrost.io/api/v0';
    this.projectId = opts.blockfrostProjectId;
    this.log = opts.log;
    this.venues = opts.venues ?? VENUE_NAMES;
    this.fetchImpl = opts.fetch ?? fetch;
    this.retryBudgetMs = opts.retryBudgetMs ?? 60_000;
    this.sleep = opts.sleep;
    this.refreshPolicy = opts.refreshPolicy ?? 'all';
    if (opts.fetcher) {
      this.fetcher = opts.fetcher;
      this.defaultFetcher = null;
    } else {
      this.defaultFetcher = new DefaultPoolFetcher({
        url: this.url, projectId: this.projectId, log: this.log, retryBudgetMs: this.retryBudgetMs, sleep: this.sleep,
      });
      this.fetcher = this.defaultFetcher;
    }
  }

  providerCalls(): number { return this.defaultFetcher?.providerCalls() ?? 0; }
  resetProviderCalls(): void { this.defaultFetcher?.resetProviderCalls(); }
  knownPoolCount(): number { return this.known.size; }
  /** Provider calls spent per venue on the most recent `discover()` (0 for any venue that made none,
   *  including all of them when `discover()` hasn't run yet, or ran against a fake `fetcher` that
   *  doesn't route through the real counting provider). Copied out so a caller can't mutate our state. */
  lastDiscoveryCalls(): Record<string, number> { return { ...this.callsByVenue }; }

  async discover(pairs: Pair[]): Promise<SourceResult> {
    const tokenPairs: Array<['lovelace', Asset]> = pairs.map((p) => ['lovelace', new Asset(p.base.policyId, p.base.assetNameHex, p.base.decimals)]);
    const failures: RunError[] = [];
    const found: PoolLike[] = [];
    this.known.clear();
    const callsByVenue: Record<string, number> = {};
    // One request per venue so a failing venue is attributable instead of vanishing into an empty array.
    for (const venue of this.venues) {
      const callsBefore = this.providerCalls();
      try {
        const pools = await this.fetcher.discoverVenue(venue, tokenPairs);
        const calls = this.providerCalls() - callsBefore;
        callsByVenue[venue] = calls;
        // Per-pool isolation: one malformed pool (e.g. an unexpected empty `address`) must not drop
        // the rest of this venue's list — each pool's mapping is its own try/catch inside collectPoolShapes.
        const { kept, failures: poolFailures } = collectPoolShapes(venue, pools);
        for (const { id, pool: like, shape } of kept) {
          this.known.set(id, shape);
          found.push(like);
        }
        for (const failure of poolFailures) {
          failures.push(failure);
          const identifier = failure.scope.slice(`discover:${venue}:`.length);
          this.log.warn({ venue, identifier, err: failure.message }, 'skipping malformed pool');
        }
        // Dexter's FetchRequest.getLiquidityPools() catches per-venue on-chain errors internally
        // and, with shouldFallbackToApi false, resolves with an empty array rather than rejecting —
        // so a broken venue is otherwise indistinguishable from a venue with genuinely zero pools.
        // Record it as a venue failure until it is verified good, rather than silently under-counting.
        // But skip this check if bounded-discovery queries failed: the query failures are the root cause.
        const partialFailures = this.fetcher.partialFailures?.(venue) ?? 0;
        if (kept.length === 0 && partialFailures === 0) {
          const failure: RunError = {
            scope: `discover:${venue}`,
            message: 'returned no pools (Dexter maps on-chain errors to an empty result); treat as venue failure until verified',
          };
          failures.push(failure);
          this.log.warn({ venue, calls }, failure.message);
        }
        // Bounded-discovery venues query one address/token pair at a time; a query failing must not
        // drop the pools other queries already found, but it also must not vanish silently — report
        // it as one venue-scoped RunError, same shape as any other discovery failure.
        if (partialFailures > 0) {
          let message = `${partialFailures} address/token queries failed`;
          if (kept.length === 0) {
            message += '; no pools returned';
          }
          const failure: RunError = { scope: `discover:${venue}`, message };
          failures.push(failure);
          this.log.warn({ venue, partialFailures, calls }, failure.message);
        }
        this.log.info({ venue, pools: kept.length, skipped: poolFailures.length, calls }, 'discovered pools');
      } catch (err) {
        const calls = this.providerCalls() - callsBefore;
        callsByVenue[venue] = calls;
        const message = (err as Error).message ?? String(err);
        failures.push({ scope: `discover:${venue}`, message });
        this.log.warn({ venue, err: message, calls }, 'discovery failed for venue');
      }
    }
    this.callsByVenue = callsByVenue;
    if (this.refreshPolicy === 'deepest') this.pruneToDeepestPerToken();
    return { pools: found, failures };
  }

  /**
   * Prunes `this.known` to one pool per base token — the pool with the largest ADA reserve, ties
   * broken by smallest identifier (see `DexterPoolSourceOptions.refreshPolicy`). `found` (the array
   * `discover()` returns to the caller) is built before this runs and is never touched by it, so a
   * discovery tick's `pool_snapshots` still get every pool this tick found; only the pools `refresh()`
   * spends calls on afterward are pruned.
   */
  private pruneToDeepestPerToken(): void {
    const discovered = this.known.size;
    const bestByToken = new Map<string, { poolId: string; shape: LiquidityPoolShape }>();
    for (const [poolId, shape] of this.known) {
      const key = groupKeyOf(poolId, shape);
      const ada = adaReserveOf(shape) ?? -1n;
      const current = bestByToken.get(key);
      const currentAda = current ? (adaReserveOf(current.shape) ?? -1n) : -1n;
      const isBetter = !current || ada > currentAda || (ada === currentAda && shape.identifier < current.shape.identifier);
      if (isBetter) bestByToken.set(key, { poolId, shape });
    }
    this.known.clear();
    for (const { poolId, shape } of bestByToken.values()) this.known.set(poolId, shape);
    this.log.info({ policy: this.refreshPolicy, discovered, kept: this.known.size }, 'pruned known pools to deepest per token');
  }

  async refresh(): Promise<SourceResult> {
    const entries = [...this.known.entries()];
    const settled = await Promise.allSettled(
      entries.map(([, shape]) => this.fetcher.poolState(shape)),
    );
    const pools: PoolLike[] = [];
    const failures: RunError[] = [];
    settled.forEach((r, i) => {
      const poolId = entries[i]?.[0] ?? '?';
      if (r.status === 'fulfilled' && r.value) {
        // Per-pool isolation: one malformed refreshed shape (e.g. an unexpected empty `address`)
        // must not reject the whole refresh — collectRefreshedShape isolates its own mapping failure.
        const { kept, failure } = collectRefreshedShape(poolId, r.value);
        if (kept) {
          this.known.set(poolId, kept.shape);
          pools.push(kept.pool);
        } else if (failure) {
          failures.push(failure);
        }
      } else {
        const message = r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason) : 'no state returned';
        failures.push({ scope: `refresh:${poolId}`, message });
      }
    });
    return { pools, failures };
  }

  async tip(): Promise<{ height: number; time: Date }> {
    return retryWithBackoff(
      async () => {
        let res: Response;
        try {
          res = await this.fetchImpl(`${this.url}/blocks/latest`, {
            headers: { project_id: this.projectId },
            signal: AbortSignal.timeout(TIP_TIMEOUT_MS),
          });
        } catch (err) {
          if (err instanceof Error && err.name === 'TimeoutError') {
            throw new Error(`blockfrost /blocks/latest timed out after ${TIP_TIMEOUT_MS} ms`);
          }
          throw err;
        }
        if (!res.ok) throw new Error(`blockfrost /blocks/latest returned ${res.status}`);
        const body = (await res.json()) as { height?: number; time?: number };
        if (typeof body.height !== 'number' || typeof body.time !== 'number') throw new Error('blockfrost /blocks/latest: missing height/time');
        return { height: body.height, time: new Date(body.time * 1000) };
      },
      {
        attempts: 4, baseMs: 500, maxMs: 8_000, budgetMs: this.retryBudgetMs,
        isTransient: isTransientHttpError,
        sleep: this.sleep,
        onRetry: (info) => this.log.warn(info, 'blockfrost retry'),
      },
    );
  }
}
