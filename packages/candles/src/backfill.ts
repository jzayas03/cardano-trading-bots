import type { Logger } from '@ctb/collector';
import type { TokenSpec } from '@ctb/universe';
import type { ExternalRepo } from './externalRepo.js';
import { chooseExternalPool, type GeckoCandle, type GeckoTerminalClient } from './geckoTerminal.js';

const MAX_PAGES = 400; // 400 pages x ~600 sparse rows covers well over a year at 5 minutes

export async function backfillToken(d: {
  client: Pick<GeckoTerminalClient, 'listAdaPools' | 'ohlcv5m'>;
  repo: ExternalRepo;
  token: Pick<TokenSpec, 'unit' | 'ticker'>;
  from: Date;
  to: Date;
  log: Logger;
}): Promise<{ pages: number; rows: number; pool: string; method: string }> {
  if (d.from.getTime() >= d.to.getTime()) throw new Error(`backfill window empty: ${d.from.toISOString()} >= ${d.to.toISOString()}`);
  let map = await d.repo.getMap(d.token.unit);
  if (!map) {
    const pools = await d.client.listAdaPools(d.token.unit);
    const chosen = chooseExternalPool(pools, await d.repo.knownMinswapV2Identifiers(d.token.unit));
    if (!chosen) throw new Error(`no ADA pool on geckoterminal for ${d.token.ticker} (${d.token.unit})`);
    await d.repo.putMap({ unit: d.token.unit, externalPoolId: chosen.pool.hex, externalDex: chosen.pool.dex, matchMethod: chosen.method, reserveUsd: chosen.pool.reserveUsd });
    map = { externalPoolId: chosen.pool.hex, externalDex: chosen.pool.dex, matchMethod: chosen.method };
    d.log.info({ ticker: d.token.ticker, pool: chosen.pool.hex, dex: chosen.pool.dex, method: chosen.method }, 'external pool chosen');
  }
  let before: Date | undefined = d.to;
  let pages = 0;
  let rows = 0;
  while (pages < MAX_PAGES) {
    const page: GeckoCandle[] = await d.client.ohlcv5m(map.externalPoolId, before);
    pages++;
    if (page.length === 0) break;
    const inWindow = page.filter((c) => c.tickTs.getTime() >= d.from.getTime() && c.tickTs.getTime() <= d.to.getTime());
    rows += await d.repo.upsertExternal(d.token.unit, map.externalPoolId, inWindow);
    const oldest = page[0]!.tickTs;
    if (oldest.getTime() < d.from.getTime()) break;
    before = oldest;
  }
  if (pages >= MAX_PAGES) d.log.warn({ ticker: d.token.ticker, pages }, 'backfill stopped at MAX_PAGES; window may be incomplete');
  return { pages, rows, pool: map.externalPoolId, method: map.matchMethod };
}
