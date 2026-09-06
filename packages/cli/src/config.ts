import { z } from 'zod';
import { DEFAULT_VENUES, isDexName, type DexName } from '@ctb/collector';

export interface Config {
  databaseUrl: string;
  blockfrostProjectId: string | null;
  intervalSec: number;
  logLevel: string;
  venues: DexName[];
}

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // dotenv sets an unset-but-present `KEY=` line to '', not undefined; without this preprocess
  // `.optional()` never fires and commands that don't need Blockfrost (migrate/status) fail closed
  // on a blank BLOCKFROST_PROJECT_ID= line in .env, which .env.example ships by design.
  BLOCKFROST_PROJECT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  COLLECT_INTERVAL_SECONDS: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 300 : Number(v)))
    .refine((n) => Number.isInteger(n) && n >= 60, 'COLLECT_INTERVAL_SECONDS must be an integer >= 60'),
  LOG_LEVEL: z.string().optional(),
  // Same '' -> undefined preprocessing as BLOCKFROST_PROJECT_ID: .env.example ships a bare
  // `COLLECT_VENUES=` line so dotenv loads '', which must mean "use the default", not "discover
  // nothing".
  COLLECT_VENUES: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
});

export function loadConfig(env: NodeJS.ProcessEnv, needs: { blockfrost: boolean }): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`config: ${first?.path.join('.') || 'env'}: ${first?.message ?? 'invalid'}`);
  }
  const v = parsed.data;
  if (needs.blockfrost && !v.BLOCKFROST_PROJECT_ID) throw new Error('config: BLOCKFROST_PROJECT_ID is required for this command');
  let venues: DexName[];
  if (v.COLLECT_VENUES === undefined) {
    venues = DEFAULT_VENUES;
  } else {
    const names = v.COLLECT_VENUES.split(',').map((s) => s.trim());
    const unknown = names.filter((n) => !isDexName(n));
    if (unknown.length > 0) throw new Error(`config: COLLECT_VENUES: unknown venue(s): ${unknown.join(', ')}`);
    venues = names as DexName[];
  }
  return {
    databaseUrl: v.DATABASE_URL,
    blockfrostProjectId: v.BLOCKFROST_PROJECT_ID ?? null,
    intervalSec: v.COLLECT_INTERVAL_SECONDS,
    logLevel: v.LOG_LEVEL ?? 'info',
    venues,
  };
}
