import { Asset, BlockfrostProvider, Dexter, type LiquidityPool } from '@indigo-labs/dexter';
import type { Pair } from '@ctb/universe';
import type { RunError } from './repo.js';
import type { PoolSource, SourceResult } from './source.js';
import { poolIdOf } from './snapshot.js';
import type { Logger, PoolLike } from './types.js';
import { VENUE_NAMES, type DexName } from './venues.js';
import { toPoolLike, type LiquidityPoolShape } from './poolShape.js';

export type { LiquidityPoolShape } from './poolShape.js';
export { toPoolLike } from './poolShape.js';

/** Counts provider method calls so each tick can report its Blockfrost cost. Paginated calls count once per method call. */
class CountingBlockfrostProvider extends BlockfrostProvider {
  calls = 0;
  override utxos(...args: Parameters<BlockfrostProvider['utxos']>) { this.calls++; return super.utxos(...args); }
  override transactionUtxos(...args: Parameters<BlockfrostProvider['transactionUtxos']>) { this.calls++; return super.transactionUtxos(...args); }
  override assetTransactions(...args: Parameters<BlockfrostProvider['assetTransactions']>) { this.calls++; return super.assetTransactions(...args); }
  override assetAddresses(...args: Parameters<BlockfrostProvider['assetAddresses']>) { this.calls++; return super.assetAddresses(...args); }
  override datumValue(...args: Parameters<BlockfrostProvider['datumValue']>) { this.calls++; return super.datumValue(...args); }
}

export interface DexterPoolSourceOptions {
  blockfrostProjectId: string;
  blockfrostUrl?: string;
  log: Logger;
  venues?: DexName[];
  fetch?: typeof fetch;
}

export class DexterPoolSource implements PoolSource {
  private readonly dexter: Dexter;
  private readonly provider: CountingBlockfrostProvider;
  private readonly known = new Map<string, LiquidityPool>();
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
    this.provider = new CountingBlockfrostProvider({ url: this.url, projectId: this.projectId }, { timeout: 20_000, retries: 2 });
    // shouldFallbackToApi false: an on-chain failure must surface as a failure, not as a quietly different data source.
    this.dexter = new Dexter({ shouldFetchMetadata: false, shouldFallbackToApi: false }, { timeout: 20_000, retries: 2 });
    this.dexter.withDataProvider(this.provider);
  }

  providerCalls(): number { return this.provider.calls; }
  resetProviderCalls(): void { this.provider.calls = 0; }
  knownPoolCount(): number { return this.known.size; }

  async discover(pairs: Pair[]): Promise<SourceResult> {
    const tokenPairs = pairs.map((p) => ['lovelace' as const, new Asset(p.base.policyId, p.base.assetNameHex, p.base.decimals)]);
    const failures: RunError[] = [];
    const found: PoolLike[] = [];
    this.known.clear();
    // One request per venue so a failing venue is attributable instead of vanishing into an empty array.
    for (const venue of this.venues) {
      try {
        const pools = await this.dexter.newFetchRequest().onDexs(venue).forTokenPairs(tokenPairs).getLiquidityPools();
        for (const pool of pools) {
          const like = toPoolLike(pool as unknown as LiquidityPoolShape);
          this.known.set(poolIdOf(like), pool);
          found.push(like);
        }
        this.log.info({ venue, pools: pools.length }, 'discovered pools');
      } catch (err) {
        failures.push({ scope: `discover:${venue}`, message: (err as Error).message ?? String(err) });
        this.log.warn({ venue, err: (err as Error).message }, 'discovery failed for venue');
      }
    }
    return { pools: found, failures };
  }

  async refresh(): Promise<SourceResult> {
    const entries = [...this.known.entries()];
    const settled = await Promise.allSettled(
      entries.map(([, pool]) => this.dexter.newFetchRequest().getLiquidityPoolState(pool)),
    );
    const pools: PoolLike[] = [];
    const failures: RunError[] = [];
    settled.forEach((r, i) => {
      const poolId = entries[i]?.[0] ?? '?';
      if (r.status === 'fulfilled' && r.value) {
        this.known.set(poolId, r.value);
        pools.push(toPoolLike(r.value as unknown as LiquidityPoolShape));
      } else {
        const message = r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason) : 'no state returned';
        failures.push({ scope: `refresh:${poolId}`, message });
      }
    });
    return { pools, failures };
  }

  async tip(): Promise<{ height: number; time: Date }> {
    const res = await this.fetchImpl(`${this.url}/blocks/latest`, { headers: { project_id: this.projectId } });
    if (!res.ok) throw new Error(`blockfrost /blocks/latest returned ${res.status}`);
    const body = (await res.json()) as { height?: number; time?: number };
    if (typeof body.height !== 'number' || typeof body.time !== 'number') throw new Error('blockfrost /blocks/latest: missing height/time');
    return { height: body.height, time: new Date(body.time * 1000) };
  }
}
