import { z } from 'zod';

export const tokenEntrySchema = z.object({
  ticker: z.string().regex(/^[A-Za-z0-9]{1,12}$/, 'ticker must be 1-12 alphanumerics'),
  policyId: z.string().regex(/^[0-9a-f]{56}$/, 'policyId must be 56 lowercase hex chars'),
  assetNameHex: z.string().regex(/^(?:[0-9a-f]{2}){0,32}$/, 'assetNameHex must be 0-32 lowercase hex bytes'),
  decimals: z.number().int().min(0).max(18),
  category: z.string().min(1),
});

export const universeFileSchema = z.object({
  seededAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seedSource: z.string().min(1),
  tokens: z.array(tokenEntrySchema).min(1),
});

export type TokenEntry = z.infer<typeof tokenEntrySchema>;
