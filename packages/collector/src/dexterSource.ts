import { Asset, BlockfrostProvider, Dexter, type LiquidityPool } from '@indigo-labs/dexter';
import type { Pair } from '@ctb/universe';
import type { RunError } from './repo.js';
import type { PoolSource, SourceResult } from './source.js';
import type { Logger, PoolLike } from './types.js';
import { VENUE_NAMES, type DexName } from './venues.js';
import { collectPoolShapes, collectRefreshedShape, type LiquidityPoolShape } from './poolShape.js';
import type { PoolFetcher } from './poolFetcher.js';

export type { LiquidityPoolShape } from './poolShape.js';
export { toPoolLike } from './poolShape.js';
export type { FetcherAsset, PoolFetcher } from './poolFetcher.js';

/** Counts provider method calls so each tick can report its Blockfrost cost. Paginated calls count once per method call. */
class CountingBlockfrostProvider extends BlockfrostProvider {
  calls = 0;
  override utxos(...args: Parameters<BlockfrostProvider['utxos']>) { this.calls++; return super.utxos(...args); }
  override transactionUtxos(...args: Parameters<BlockfrostProvider['transactionUtxos']>) { this.calls++; return super.transactionUtxos(...args); }
  override assetTransactions(...args: Parameters<BlockfrostProvider['assetTransactions']>) { this.calls++; return super.assetTransactions(...args); }
  override assetAddresses(...args: Parameters<BlockfrostProvider['assetAddresses']>) { this.calls++; return super.assetAddresses(...args); }
  override datumValue(...args: Parameters<BlockfrostProvider['datumValue']>) { this.calls++; return super.datumValue(...args); }
}

/** The real `PoolFetcher`: wraps Dexter exactly as `DexterPoolSource` always has. Constructing it is
 *  synchronous and makes no network call (Dexter/BlockfrostProvider only build an axios client in
 *  their constructors), so it is safe to construct even in a unit test that never calls it. */
class DefaultPoolFetcher implements PoolFetcher {
  private readonly dexter: Dexter;
  private readonly provider: CountingBlockfrostProvider;

  constructor(url: string, projectId: string) {
    this.provider = new CountingBlockfrostProvider({ url, projectId }, { timeout: 20_000, retries: 2 });
    // shouldFallbackToApi false: an on-chain failure must surface as a failure, not as a quietly different data source.
    this.dexter = new Dexter({ shouldFetchMetadata: false, shouldFallbackToApi: false }, { timeout: 20_000, retries: 2 });
    this.dexter.withDataProvider(this.provider);
  }

  providerCalls(): number { return this.provider.calls; }
  resetProviderCalls(): void { this.provider.calls = 0; }

  async discoverVenue(venue: DexName, tokenPairs: Array<['lovelace', Asset]>): Promise<LiquidityPoolShape[]> {
    const pools = await this.dexter.newFetchRequest().onDexs(venue).forTokenPairs(tokenPairs).getLiquidityPools();
    return pools as unknown as LiquidityPoolShape[];
  }

  async poolState(pool: LiquidityPoolShape): Promise<LiquidityPoolShape | undefined> {
    const state = await this.dexter.newFetchRequest().getLiquidityPoolState(pool as unknown as LiquidityPool);
    return state as unknown as LiquidityPoolShape | undefined;
  }
}

export interface DexterPoolSourceOptions {
  blockfrostProjectId: string;
  blockfrostUrl?: string;
  log: Logger;
  venues?: DexName[];
  fetch?: typeof fetch;
  /** Injectable seam for tests. Omit to use the real Dexter-backed fetcher. */
  fetcher?: PoolFetcher;
}

const TIP_TIMEOUT_MS = 10_000;

export class DexterPoolSource implements PoolSource {
  private readonly fetcher: PoolFetcher;
  private readonly defaultFetcher: DefaultPoolFetcher | null;
  private readonly known = new Map<string, LiquidityPoolShape>();
  private readonly venues: DexName[];
  private readonly url: string;
  private readonly projectId: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DexterPoolSourceOptions) {
    this.url = opts.blockfrostUrl ?? 'https://cardano-mainnet.blockfrost.io/api/v0';
    this.projectId = opts.blockfrostProjectId;
    this.log = opts.log;
    this.venues = opts.venues ?? VENUE_NAMES;
    this.fetchImpl = opts.fetch ?? fetch;
    if (opts.fetcher) {
      this.fetcher = opts.fetcher;
      this.defaultFetcher = null;
    } else {
      this.defaultFetcher = new DefaultPoolFetcher(this.url, this.projectId);
      this.fetcher = this.defaultFetcher;
    }
  }

  providerCalls(): number { return this.defaultFetcher?.providerCalls() ?? 0; }
  resetProviderCalls(): void { this.defaultFetcher?.resetProviderCalls(); }
  knownPoolCount(): number { return this.known.size; }

  async discover(pairs: Pair[]): Promise<SourceResult> {
    const tokenPairs: Array<['lovelace', Asset]> = pairs.map((p) => ['lovelace', new Asset(p.base.policyId, p.base.assetNameHex, p.base.decimals)]);
    const failures: RunError[] = [];
    const found: PoolLike[] = [];
    this.known.clear();
    // One request per venue so a failing venue is attributable instead of vanishing into an empty array.
    for (const venue of this.venues) {
      try {
        const pools = await this.fetcher.discoverVenue(venue, tokenPairs);
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
        if (kept.length === 0) {
          const failure: RunError = {
            scope: `discover:${venue}`,
            message: 'returned no pools (Dexter maps on-chain errors to an empty result); treat as venue failure until verified',
          };
          failures.push(failure);
          this.log.warn({ venue }, failure.message);
        }
        this.log.info({ venue, pools: kept.length, skipped: poolFailures.length }, 'discovered pools');
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        failures.push({ scope: `discover:${venue}`, message });
        this.log.warn({ venue, err: message }, 'discovery failed for venue');
      }
    }
    return { pools: found, failures };
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
  }
}
